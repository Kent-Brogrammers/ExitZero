# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
COPY shared/ /build/shared/
# Keep production API calls on the same origin as the frontend.
ENV VITE_API_BASE_URL=/api
RUN npm run build

FROM rust:1.99.1-slim-bookworm AS backend-build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY backend/Cargo.toml ./backend/Cargo.toml
COPY backend/src/ ./backend/src/
COPY crates/exitzero-core/ ./crates/exitzero-core/
ENV CARGO_PROFILE_RELEASE_STRIP=symbols
RUN cargo build --release --locked -p exitzero --bin exitzero

FROM debian:bookworm-slim AS runtime
WORKDIR /app
COPY --from=backend-build /build/target/release/exitzero /usr/local/bin/exitzero
COPY --from=frontend-build /build/frontend/dist/ /app/frontend/
ENV PORT=10000 \
    EXITZERO_FRONTEND_DIR=/app/frontend \
    EXITZERO_COMPUTE_WORKERS=1 \
    TOKIO_WORKER_THREADS=2
USER 10001:10001
EXPOSE 10000
CMD ["/usr/local/bin/exitzero"]
