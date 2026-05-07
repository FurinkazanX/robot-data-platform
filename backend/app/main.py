import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from app.api import files, convert, transfer, visualize, monitor

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
_ASSETS_DIR = os.path.join(STATIC_DIR, "assets")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="机器人数据平台", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(files.router, prefix="/api/files", tags=["files"])
app.include_router(convert.router, prefix="/api/convert", tags=["convert"])
app.include_router(transfer.router, prefix="/api/transfer", tags=["transfer"])
app.include_router(visualize.router, prefix="/api/visualize", tags=["visualize"])
app.include_router(monitor.router, prefix="/api/monitor", tags=["monitor"])

# Serve Vite-built hashed assets (JS / CSS / images)
if os.path.isdir(_ASSETS_DIR):
    app.mount("/assets", StaticFiles(directory=_ASSETS_DIR), name="assets")

# SPA catch-all: serve real files if they exist, otherwise return index.html
# so that client-side routes (e.g. /monitor, /convert) work on page refresh.
@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    candidate = os.path.join(STATIC_DIR, full_path)
    if os.path.isfile(candidate):
        return FileResponse(candidate)
    index = os.path.join(STATIC_DIR, "index.html")
    if os.path.isfile(index):
        return FileResponse(index)
    return {"detail": "Not Found"}
