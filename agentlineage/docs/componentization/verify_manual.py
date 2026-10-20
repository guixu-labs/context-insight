"""Validate the maintained Markdown and its built PDF without running examples."""
from pathlib import Path
import hashlib
import json
import re
import sys

import pdfplumber
from pypdf import PdfReader
import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
source_path = HERE / 'README.zh-CN.md'
pdf_path = ROOT / 'output/pdf/DSH-组件化101与接入SOP.pdf'
source = source_path.read_text(encoding='utf-8')
build = json.loads((ROOT / 'tmp/pdfs/pdf-build.json').read_text(encoding='utf-8'))
errors = []
headings = []
fenced = False
for line in source.splitlines():
    if line.startswith('```'):
        fenced = not fenced
    elif not fenced:
        match = re.match(r'^#{2,3} (.+)$', line)
        if match:
            headings.append(match[1])
slugs = {re.sub(r'[^\w\-\s]', '', title.lower()).replace(' ', '-') for title in headings}
links = re.findall(r'\[([^\]]+)\]\(([^)]+)\)', source)
for label, target in links:
    if target.startswith('#') and target[1:] not in slugs:
        errors.append('Missing heading: ' + target)
    elif not target.startswith(('http', '#')) and not (HERE / target.split('#')[0]).exists():
        errors.append('Missing local file: ' + target)
if '\ufffd' in source:
    errors.append('Replacement character in Markdown')
if any(line.rstrip() != line for line in source.splitlines()):
    errors.append('Trailing whitespace in Markdown')


class Loader(yaml.SafeLoader):
    pass


Loader.add_constructor('tag:yaml.org,2002:js', lambda loader, node: loader.construct_scalar(node))
blocks = re.findall(r'^```(json|yaml)\s*\n(.*?)^```', source, re.M | re.S)
for kind, content in blocks:
    try:
        json.loads(content) if kind == 'json' else yaml.load(content, Loader=Loader)
    except Exception as exc:
        errors.append(f'Invalid {kind}: {exc}')

reader = PdfReader(pdf_path)
page_ids = {page.indirect_reference.idnum: i + 1 for i, page in enumerate(reader.pages)}
pdf_links = 0
toc_targets = []
first_chapter = next(item['page'] for item in build['headings'] if item['title'].startswith('1 '))
for number, page in enumerate(reader.pages, 1):
    for ref in page.get('/Annots', []):
        annotation = ref.get_object()
        if annotation.get('/Subtype') != '/Link':
            continue
        pdf_links += 1
        dest = annotation.get('/Dest')
        if dest:
            target = page_ids.get(dest[0].idnum)
            if target is None:
                errors.append(f'Invalid PDF destination on page {number}')
            if 3 <= number < first_chapter:
                toc_targets.append(target)

outlines = []


def collect(entries):
    for entry in entries:
        if isinstance(entry, list):
            collect(entry)
        else:
            outlines.append((entry.title, reader.get_destination_page_number(entry) + 1))


collect(reader.outline)
expected = [(item['title'], item['page']) for item in build['headings']]
if outlines != expected:
    errors.append('PDF outlines differ from rendered headings')
toc_expected = [item['page'] for item in build['headings'] if item['title'] not in ('目录', '操作指引')]
# ReportLab creates one link for each label and one for its printed page number.
if toc_targets != [page for number in toc_expected for page in (number, number)]:
    errors.append('TOC destinations differ from heading pages')

texts = []
with pdfplumber.open(pdf_path) as pdf:
    for number, page in enumerate(pdf.pages, 1):
        text = page.extract_text() or ''
        texts.append(text)
        if not text.strip():
            errors.append(f'Empty PDF page {number}')
        bad = [char for char in page.chars if char['x0'] < 27 or char['x1'] > page.width - 31 or char['top'] < 10 or char['bottom'] > page.height - 10]
        if bad:
            errors.append(f'Text outside page limits: {number}')

toc_text = '\n'.join(texts[2:first_chapter - 1])
compact_toc = re.sub(r'[^\S\n]+', '', toc_text)
toc_numbers = 0
for item in build['headings']:
    if item['title'] in ('目录', '操作指引'):
        continue
    label = re.sub(r'\s+', '', item['title'])
    pattern = re.escape(label) + r'[.·…\n]*' + str(item['page']) + r'(?=\n|$)'
    if not re.search(pattern, compact_toc):
        errors.append('TOC printed page not found: ' + item['title'])
    else:
        toc_numbers += 1

report = {
    'version': re.search(r'版本：讨论稿 (v[\d.]+)', source).group(1),
    'pages': len(reader.pages),
    'outline_entries': len(outlines),
    'toc_entries_checked': toc_numbers,
    'clickable_links': pdf_links,
    'markdown_links_checked': len(links),
    'config_blocks_checked': len(blocks),
    'sha256': hashlib.sha256(pdf_path.read_bytes()).hexdigest(),
    'markdown_sha256': hashlib.sha256(source_path.read_bytes()).hexdigest(),
    'errors': errors,
    'headings': build['headings'],
    'visual_review': 'pending',
    'execution_scope': 'Text, configuration syntax and PDF only. No publishing, marketplace submission, DSH activation or model invocation.',
}
out = ROOT / 'output/pdf/DSH-componentization-validation.json'
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in report.items() if key != 'headings'}, ensure_ascii=True))
sys.exit(1 if errors else 0)
