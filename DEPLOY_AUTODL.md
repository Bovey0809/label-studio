# Deploying Label Studio (this fork) on an AutoDL server

Runbook for running this forked Label Studio — including the **video_index**
(ffmpeg frame-alignment) pipeline — on an AutoDL GPU instance.

AutoDL boxes have: conda `base` (Python 3.12), a small full root disk, a large
data disk at `/root/autodl-tmp`, **no Node**, **no Docker**, and **no direct
internet** (GitHub is blocked) — so the workflow is: build the frontend
locally, ship it, run Python on the server.

Concrete values used in the current deployment (substitute your own):

| Thing | Value |
|---|---|
| SSH host alias | `labelstudio` (`connect.bjb1.seetacloud.com:22164`, user `root`) |
| Code dir (server) | `/root/autodl-tmp/label-studio` |
| Data dir (sqlite) | `/root/autodl-tmp/ls-data` |
| Local-files root | `/root/autodl-tmp/ls-files` |
| Public URL | `https://u7359-acaf-4c625285.bjb1.seetacloud.com:8443` (AutoDL custom service → container `:6006`) |
| Admin | `admin@ultralytics.com` / `<set via LABEL_STUDIO_PASSWORD on first launch>` |

---

## 0. One-time SSH key auth

```bash
ssh-keygen -y -f ~/.ssh/id_rsa > ~/.ssh/id_rsa.pub   # if .pub missing
ssh-copy-id -o StrictHostKeyChecking=accept-new labelstudio   # enter password once
ssh labelstudio 'echo ok'                              # should not prompt
```

## 1. Build the frontend locally (Node lives on your machine, not the server)

```bash
cd web
yarn install --frozen-lockfile --ignore-engines
BUILD_NO_SERVER=true BUILD_NO_HASH=true BUILD_NO_CHUNKS=true BUILD_MODULE=true \
  NODE_ENV=production yarn build          # -> web/dist (editor+datamanager bundled into apps/labelstudio)
```

## 2. Ship source + built frontend to the server

`rsync` may be absent locally; stream a tar instead. Ship only the runtime set
(skip `.git`, `node_modules`, `web/libs` source, `docs`, data dirs).

```bash
cd /path/to/label-studio
ssh labelstudio 'mkdir -p /root/autodl-tmp/label-studio'
tar czf - --exclude='__pycache__' --exclude='*.pyc' \
  label_studio web/dist pyproject.toml poetry.lock README.md deploy LICENSE licenses \
  | ssh labelstudio 'tar xzf - -C /root/autodl-tmp/label-studio'
```

## 3. Install the Python package (editable) in conda base

GitHub is blocked, but `pip install` pins `label-studio-sdk` to a GitHub
archive. Enable AutoDL's academic proxy for GitHub, but keep the domestic
Aliyun PyPI mirror OFF the proxy (the proxy breaks it):

```bash
ssh labelstudio bash -lc '
  source /etc/network_turbo                       # proxy for github/huggingface
  export no_proxy="mirrors.aliyun.com,aliyun.com,localhost,127.0.0.1"
  export NO_PROXY="$no_proxy"
  source /root/miniconda3/etc/profile.d/conda.sh && conda activate base
  cd /root/autodl-tmp/label-studio
  pip install -v -e .
'
```

## 4. System services for video_index (ffprobe + Redis + worker)

The editor blocks on a per-video ffmpeg index. The server builds it with
`ffprobe`, dispatched via an **rq worker** over **Redis** (`compute_video_index`
is `@job("low") + .delay()` — it needs a real worker, there is no sync fallback).
Without these, the editor hangs on "Preparing video index…" and bboxes never render.

```bash
ssh labelstudio bash -lc '
  apt-get update && apt-get install -y ffmpeg redis-server
  redis-server --daemonize yes
  ffprobe -version | head -1
'
```

## 5. collectstatic (once, and after frontend rebuilds)

```bash
ssh labelstudio bash -lc '
  source /root/miniconda3/etc/profile.d/conda.sh && conda activate base
  export LABEL_STUDIO_BASE_DATA_DIR=/root/autodl-tmp/ls-data DJANGO_SETTINGS_MODULE=core.settings.label_studio
  cd /root/autodl-tmp/label-studio/label_studio
  python manage.py collectstatic --no-input      # -> core/static_build, else /static/ fonts 404
'
```

## 6. Start scripts

Create these on the server (pipe a local heredoc into `cat` — heredocs inside a
quoted ssh arg break).

**`/root/autodl-tmp/start_ls.sh`** (web server):
```bash
ssh labelstudio 'cat > /root/autodl-tmp/start_ls.sh && chmod +x /root/autodl-tmp/start_ls.sh' <<'EOF'
#!/bin/bash
source /root/miniconda3/etc/profile.d/conda.sh
conda activate base
export LABEL_STUDIO_BASE_DATA_DIR=/root/autodl-tmp/ls-data
export LABEL_STUDIO_HOST=https://u7359-acaf-4c625285.bjb1.seetacloud.com:8443
export CSRF_TRUSTED_ORIGINS=https://u7359-acaf-4c625285.bjb1.seetacloud.com:8443
export LOCAL_FILES_SERVING_ENABLED=true
export LOCAL_FILES_DOCUMENT_ROOT=/root/autodl-tmp/ls-files
cd /root/autodl-tmp/label-studio
exec label-studio start --host 0.0.0.0 --port 6006 --no-browser
EOF
```

**`/root/autodl-tmp/start_worker.sh`** (index builder — SAME env so it resolves
local-files to disk and uses the same DB):
```bash
ssh labelstudio 'cat > /root/autodl-tmp/start_worker.sh && chmod +x /root/autodl-tmp/start_worker.sh' <<'EOF'
#!/bin/bash
source /root/miniconda3/etc/profile.d/conda.sh
conda activate base
export LABEL_STUDIO_BASE_DATA_DIR=/root/autodl-tmp/ls-data
export DJANGO_SETTINGS_MODULE=core.settings.label_studio
export LOCAL_FILES_SERVING_ENABLED=true
export LOCAL_FILES_DOCUMENT_ROOT=/root/autodl-tmp/ls-files
export VIDEO_INDEX_FFPROBE_PATH=/usr/bin/ffprobe
cd /root/autodl-tmp/label-studio/label_studio
exec python manage.py rqworker critical high default low
EOF
```

> **Why HOST/CSRF:** AutoDL terminates TLS and proxies plain HTTP to `:6006`, so
> Django sees scheme `http` while the browser `Origin` is `https://…:8443`.
> Login POST 403s unless the full public URL is in `CSRF_TRUSTED_ORIGINS`
> (`LABEL_STUDIO_HOST` alone does not populate it).

## 7. Launch (order matters)

**Redis first, then worker, then web server.** If LS starts before Redis, its
enqueue silently never lands jobs.

```bash
ssh labelstudio 'redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes'
ssh labelstudio 'setsid bash /root/autodl-tmp/start_worker.sh </dev/null >/root/autodl-tmp/ls_worker.log 2>&1 & echo started'
ssh labelstudio 'setsid bash /root/autodl-tmp/start_ls.sh     </dev/null >/root/autodl-tmp/ls_server.log 2>&1 & echo started'
```

> Launch each with `setsid … & echo` as a STANDALONE command. Combining
> `pkill …; setsid … &` in one compound silently fails to launch.
> None of redis/worker/LS auto-start on container reboot — re-run this section.

## 8. Access

Enable AutoDL's **custom service** (console) mapping container port `6006`;
open the public URL it gives you. Or tunnel: `ssh -N -L 8088:localhost:6006 labelstudio`
then `http://localhost:8088`.

## 9. Updating after code changes (redeploy)

```bash
# frontend changed -> rebuild
cd web && BUILD_NO_SERVER=true BUILD_NO_HASH=true BUILD_NO_CHUNKS=true BUILD_MODULE=true NODE_ENV=production yarn build
# ship dist + only the changed backend files (don't clobber server-generated static_build/version_.py/DB)
cd .. && tar czf - web/dist label_studio/<changed>.py | ssh labelstudio 'tar xzf - -C /root/autodl-tmp/label-studio'
# restart BOTH services (worker imports video_index code).
# NOTE: use self-excluding bracket patterns `[b]`/`[m]` — a plain `pkill -f rqworker`
# run over ssh matches its OWN launching shell (whose command line contains "rqworker")
# and kills the session before the real workers, leaving stale old-code workers alive.
ssh labelstudio 'pkill -9 -f "[b]in/label-studio"; pkill -9 -f "[m]anage.py rqworker"; sleep 2'
# verify nothing stale survived (should print only what you are about to start, i.e. nothing):
ssh labelstudio 'ps -eo pid,lstart,cmd | grep -E "[m]anage.py rqworker|[b]in/label-studio" || echo "all stopped ✓"'
ssh labelstudio 'setsid bash /root/autodl-tmp/start_worker.sh </dev/null >/root/autodl-tmp/ls_worker.log 2>&1 & echo ok'
ssh labelstudio 'setsid bash /root/autodl-tmp/start_ls.sh     </dev/null >/root/autodl-tmp/ls_server.log 2>&1 & echo ok'
```

`pip install` again only if `pyproject.toml`/`poetry.lock` changed; `migrate`
only if there are new migrations (`git diff --name-only <base>..HEAD | grep migration`).

## 10. Serving local video files

Tasks reference `/data/local-files/?d=<rel>`; files live under
`LOCAL_FILES_DOCUMENT_ROOT`. The serve view 404s unless a
`LocalFilesImportStorage` row exists for the project whose `path` is a prefix
of the file:

```python
# manage.py shell
from io_storages.localfiles.models import LocalFilesImportStorage
LocalFilesImportStorage.objects.create(project_id=<id>, path="/root/autodl-tmp/ls-files", use_blob_urls=False)
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Editor stuck "Preparing video index…", bbox doesn't render | ffprobe/Redis/worker missing, or LS started before Redis. Do §4+§7; then delete stale rows: `VideoIndex.objects.exclude(status="ready").delete()` (PENDING rows never auto-retry). |
| `/api/video-index/` 500 `Connection refused localhost:6379` | Redis not running → `redis-server --daemonize yes`, restart LS. |
| `/api/video-index/` stuck at 202 | No worker, or no ffprobe, or stale PENDING row. Check `ls_worker.log`. |
| `/api/video-index/` 409 `backend cannot fetch url` (uploaded/"import mp4" video) | The resolver maps the served-media URL (`/data/upload/<rel>`) to `MEDIA_ROOT` on disk; ensure the running worker has that code (`VideoUrlResolver._resolve_media_files`) and no stale old worker is alive (next row). Delete the `unavailable` row and re-trigger. |
| Index keeps coming back wrong after a deploy | A stale **old-code** rqworker survived the restart and grabbed the job. List them with `ps -eo pid,lstart,cmd \| grep "[m]anage.py rqworker"`, kill leftovers by PID, keep exactly one. Caused by the `pkill` self-match — see the bracket-pattern note in §9. |
| `pip` "No matching distribution for poetry-core" | Proxy is breaking Aliyun mirror → set `no_proxy` (§3). |
| Login POST 403 | Public URL not in `CSRF_TRUSTED_ORIGINS`. |
| `/static/` fonts 404 | Run `collectstatic` (§5), restart LS. |
| Public URL 502 | AutoDL custom-service toggle for port 6006 is off. |

## Verify ffmpeg alignment (optional)

```bash
ssh labelstudio bash -lc '
  source /root/miniconda3/etc/profile.d/conda.sh && conda activate base
  export DJANGO_SETTINGS_MODULE=core.settings.label_studio VIDEO_INDEX_FFPROBE_PATH=/usr/bin/ffprobe PYTHONPATH=/root/autodl-tmp/label-studio/label_studio
  cd /root/autodl-tmp/label-studio/label_studio
  python ../scripts/verify_ffmpeg_alignment.py /root/autodl-tmp/ls-files/<video>.mp4
'
```
