# /home/dyfluid/work/Foam-Agent/bridge.py
import os, uuid, subprocess, threading, time, json, shutil
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

FOAM_AGENT_ROOT = Path("/home/dyfluid/work/Foam-Agent").resolve()
RUNS_DIR        = FOAM_AGENT_ROOT / "runs"
OUTPUT_ROOT     = FOAM_AGENT_ROOT / "output"
OPENFOAM_PATH   = os.environ.get("WM_PROJECT_DIR", "/home/dyfluid/OpenFOAM/OpenFOAM-10")

app = FastAPI(title="Foam-Agent Bridge", version="1.0.0")
# 允许你本机前端 http://localhost:8000 跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class RunRequest(BaseModel):
    requirement: str  # 前端传来的英文需求（已用 DeepSeek 翻译）
    case_name: str | None = None  # 可选：给这次任务起个名

JOBS = {}   # {job_id: {...状态...}}

def zip_dir(src_dir: Path, zip_path: Path):
    if zip_path.exists(): zip_path.unlink()
    shutil.make_archive(zip_path.with_suffix(""), "zip", src_dir)

def _run_job(job_id: str):
    job = JOBS[job_id]
    workdir   = job["workdir"]
    outdir    = job["outdir"]
    logfile   = job["logfile"]

    cmd = [
        "python", "foambench_main.py",
        "--openfoam_path", OPENFOAM_PATH,
        "--output", str(outdir),
        "--prompt_path", str(workdir / "user_requirement.txt")
    ]
    with open(logfile, "wb") as logf:
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(FOAM_AGENT_ROOT),
                stdout=logf, stderr=subprocess.STDOUT, env=os.environ.copy()
            )
            JOBS[job_id]["pid"] = proc.pid
            ret = proc.wait()
            JOBS[job_id]["returncode"] = ret
            if ret == 0:
                # 打包 zip
                zip_path = OUTPUT_ROOT / f"{job_id}.zip"
                zip_dir(outdir, zip_path)
                JOBS[job_id]["zip"]   = str(zip_path)
                JOBS[job_id]["state"] = "finished"
            else:
                JOBS[job_id]["state"] = "failed"
        except Exception as e:
            JOBS[job_id]["state"] = "failed"
            JOBS[job_id]["error"] = str(e)

@app.get("/health")
def health():
    return {"ok": True, "wm_project_dir": OPENFOAM_PATH}

@app.post("/run")
def run(req: RunRequest):
    if not req.requirement.strip():
        raise HTTPException(400, "Empty requirement")

    job_id = uuid.uuid4().hex[:12]
    workdir = RUNS_DIR / job_id
    outdir  = OUTPUT_ROOT / job_id
    workdir.mkdir(parents=True, exist_ok=True)
    outdir.mkdir(parents=True, exist_ok=True)

    # 写 user_requirement.txt（Foam-Agent 将读取它）
    (workdir / "user_requirement.txt").write_text(req.requirement, encoding="utf-8")

    JOBS[job_id] = {
        "state": "running",
        "created_at": time.time(),
        "workdir": str(workdir),
        "outdir":  str(outdir),
        "logfile": str(workdir / "run.log"),
        "zip": None,
        "returncode": None,
        "case_name": req.case_name or "",
    }

    t = threading.Thread(target=_run_job, args=(job_id,), daemon=True)
    t.start()
    return {"job_id": job_id}

@app.get("/status/{job_id}")
def status(job_id: str):
    job = JOBS.get(job_id)
    if not job: raise HTTPException(404, "job not found")
    # 读尾部日志
    tail = ""
    log = Path(job["logfile"])
    if log.exists():
        try:
            tail = log.read_text(encoding="utf-8", errors="ignore")[-2000:]
        except Exception:
            tail = ""
    return {
        "state": job["state"],
        "returncode": job["returncode"],
        "log_tail": tail,
        "zip": job["zip"],
        "created_at": job["created_at"],
        "case_name": job["case_name"],
    }

from fastapi.responses import FileResponse
@app.get("/download/{job_id}")
def download(job_id: str):
    job = JOBS.get(job_id)
    if not job or not job.get("zip"): raise HTTPException(404, "no zip")
    return FileResponse(
        path=job["zip"], filename=f"{job_id}.zip",
        media_type="application/zip"
    )

