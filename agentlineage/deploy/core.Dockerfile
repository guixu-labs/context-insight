FROM python:3.12-slim
ARG VERSION=0.1.0a2
COPY components/core/dist/agentlineage_core-${VERSION}-py3-none-any.whl /tmp/core.whl
RUN mv /tmp/core.whl /tmp/agentlineage_core-${VERSION}-py3-none-any.whl && \
    pip install --no-cache-dir /tmp/agentlineage_core-${VERSION}-py3-none-any.whl && \
    useradd --create-home --uid 10001 lineage && mkdir /data && chown lineage /data
USER lineage
VOLUME /data
EXPOSE 8110
ENTRYPOINT ["agentlineage"]
CMD ["--data-dir", "/data", "serve", "--host", "0.0.0.0", "--port", "8110"]
