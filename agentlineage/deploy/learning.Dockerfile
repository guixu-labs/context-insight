FROM python:3.12-slim
ARG VERSION=0.1.0a2
COPY components/core/dist/agentlineage_core-${VERSION}-py3-none-any.whl /tmp/wheels/
COPY components/learning/dist/agentlineage_learning-${VERSION}-py3-none-any.whl /tmp/wheels/
RUN pip install --no-cache-dir /tmp/wheels/*.whl && \
    useradd --create-home --uid 10001 lineage && mkdir /data && chown lineage /data
USER lineage
VOLUME /data
EXPOSE 8111
ENTRYPOINT ["agentlineage-learning"]
CMD ["--data-dir", "/data", "serve", "--host", "0.0.0.0", "--port", "8111"]
