"""Prepare/share a session index and delegate all semantics to migloop.inquiry."""
from pathlib import Path
import os
from uuid import uuid4

from .common import fingerprint, load
from .provenance import verify_materials

CORE_EXCLUDED = {"__main__.py", "interfaces.py", "web.py", "viewer.py"}


def kernel():
    from agentlineage_core.sdk import inquiry_kernel
    return inquiry_kernel()


def job_metadata(job_path):
    job_path = Path(job_path).resolve()
    job = load(job_path)
    if job.get("schema") != "migloop-issue-job/1":
        raise ValueError("Expected a dispatch-created issue job")
    metadata_path = (job_path.parent / job["provenance_path"]).resolve()
    metadata = load(metadata_path)
    if fingerprint(metadata) != job["provenance_sha256"]:
        raise ValueError("Frozen job provenance changed; recollect and redispatch")
    verify_materials(metadata)
    return job, metadata, metadata_path


def sources_for(metadata, describe_source):
    materials = Path(metadata["materials"]).resolve()
    if materials.is_file() and materials.suffix.lower() in (".sqlite", ".sqlite3", ".db"):
        raise ValueError("Native DevEco DB graph import is not supported by this inquiry kernel. "
                         "Use an exported JSONL pool with original coordinates; metadata-only collection is not graph validation.")
    root = materials if materials.is_dir() else materials.parent
    return [describe_source(root / source["source"], source["source"]) for source in metadata["sources"]]


def validate_index(db, metadata, Store, sources, core_sha, *, managed=False):
    store = Store(str(db))
    try:
        rows = store.rows("SELECT name,path,size,mtime FROM sources")
        actual = {(r["name"], str(Path(r["path"]).resolve()))
                  for r in rows}
        expected = {(s.name, str(Path(s.path).resolve())) for s in sources}
        if actual != expected:
            raise ValueError("Index belongs to a different source pool; prepare the index for this job")
        for row in rows:
            stat = Path(row["path"]).stat()
            if stat.st_size != row["size"] or stat.st_mtime_ns != row["mtime"]:
                raise ValueError("Indexed source changed since import; prepare a new index: " + row["name"])
        tags = dict(store.db.execute("SELECT key,value FROM meta"))
        if managed or "memory_core_sha256" in tags:
            if tags.get("memory_core_sha256") != core_sha or tags.get("memory_source_set_id") != metadata["source_set_id"]:
                raise ValueError("Index source/kernel revision mismatch; prepare with this release")
    finally:
        store.close()


def prepare(job_path, db=None, cache_dir=None):
    job, metadata, metadata_path = job_metadata(job_path)
    Engine, check, Store, describe_source, core_sha = kernel()
    sources = sources_for(metadata, describe_source)
    key = fingerprint({"sources": metadata["source_set_id"], "kernel": core_sha,
                       "locations": [(s.name, str(Path(s.path).resolve())) for s in sources]})
    if db:
        db = Path(db).resolve()
        if not db.is_file():
            raise ValueError("Explicit inquiry DB does not exist; omit --db to prepare it automatically")
        validate_index(db, metadata, Store, sources, core_sha)
        return {"db": str(db), "reused": True, "kernel_sha256": core_sha, "source_set_id": metadata["source_set_id"]}
    directory = Path(cache_dir).resolve() if cache_dir else metadata_path.parent / ".inquiry"
    directory = directory / key
    if directory.exists():
        directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    db, lock = directory / "index.sqlite", directory / "build.lock"
    if db.exists():
        validate_index(db, metadata, Store, sources, core_sha, managed=True)
        return {"db": str(db), "reused": True, "kernel_sha256": core_sha, "source_set_id": metadata["source_set_id"]}
    try:
        handle = lock.open("x", encoding="utf-8")
    except FileExistsError as exc:
        raise ValueError("Another worker is preparing this session index. Retry after prepare finishes; do not delete its lock.") from exc
    temporary = directory / (".building-" + uuid4().hex + ".sqlite")
    try:
        with handle:
            handle.write(str(os.getpid()))
        if db.exists():
            validate_index(db, metadata, Store, sources, core_sha, managed=True)
            reused = True
        else:
            store = Store.build(temporary, sources)
            try:
                store.db.executemany("INSERT INTO meta VALUES(?,?)", [
                    ("memory_core_sha256", core_sha), ("memory_source_set_id", metadata["source_set_id"])])
                store.db.commit()
            finally:
                store.close()
            verify_materials(metadata)
            temporary.rename(db)
            reused = False
    finally:
        # Only this invocation's unique temporary file and acquired lock are removed.
        temporary.unlink(missing_ok=True)
        lock.unlink()
    return {"db": str(db), "reused": reused, "kernel_sha256": core_sha, "source_set_id": metadata["source_set_id"]}


def query(job_path, request_path=None, db=None, result_id=None, offset=0):
    prepared = prepare(job_path, db)
    job = load(job_path)
    Engine, _, Store, _, _ = kernel()
    store = Store(prepared["db"])
    try:
        engine = Engine(store, session="memory-card:" + job["id"], origin="memory-skill")
        if result_id is not None:
            return engine.page(result_id, offset)
        request = load(request_path)
        return engine.investigate(request if isinstance(request, list) else [request])
    finally:
        store.close()
