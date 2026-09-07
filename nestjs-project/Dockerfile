# Multi-stage build. Currently holds only the `worker` target — the API
# service keeps using Dockerfile.dev for local development.

FROM node:25.6.0-slim AS worker

# FFmpeg is needed only by the video-worker, not the API image
# (phase-03-videos/TD-06, TD-07).
RUN apt update && apt install -y procps curl ffmpeg

WORKDIR /home/node/app

USER node

CMD [ "tail", "-f", "/dev/null" ]
