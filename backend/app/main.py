import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from app.api import files, convert, transfer, visualize

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")


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

# Serve React SPA — must be last
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
