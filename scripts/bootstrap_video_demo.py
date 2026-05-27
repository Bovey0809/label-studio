"""Seed a ready-to-test video project: org + admin user + project + two tasks.
Run:  manage.py shell < scripts/bootstrap_video_demo.py
Videos are referenced as LS local-storage URLs; LOCAL_FILES_DOCUMENT_ROOT=/home/rick.
"""
from django.conf import settings
from organizations.models import Organization
from projects.models import Project
from tasks.models import Task
from users.models import User

EMAIL = "admin@example.com"
PASSWORD = "videoindex123"

# Videos under LOCAL_FILES_DOCUMENT_ROOT (=/home/rick), referenced by ?d=<relative>.
VIDEOS = [
    ("VFR phone clip (142 frames)", "auto_pipeline/Feishu20260424-135236.mp4"),
    ("CFR people 12fps (596 frames)", "people-detection.mp4"),
]

LABEL_CONFIG = """
<View>
  <Labels name="videoLabels" toName="video" allowEmpty="true">
    <Label value="Object" background="#1f77b4"/>
    <Label value="Person" background="#ff7f0e"/>
  </Labels>
  <Video name="video" value="$video"/>
  <VideoRectangle name="box" toName="video"/>
</View>
""".strip()

print("LOCAL_FILES_SERVING_ENABLED:", getattr(settings, "LOCAL_FILES_SERVING_ENABLED", None))
print("LOCAL_FILES_DOCUMENT_ROOT  :", getattr(settings, "LOCAL_FILES_DOCUMENT_ROOT", None))

user = User.objects.filter(email=EMAIL).first()
if user is None:
    user = User.objects.create_user(email=EMAIL, password=PASSWORD)
    print("created user", EMAIL)
else:
    user.set_password(PASSWORD)
    user.save()
    print("reset password for existing user", EMAIL)

org = user.active_organization or Organization.objects.filter(created_by=user).first()
if org is None:
    org = Organization.create_organization(created_by=user, title="Video Demo Org")
    print("created organization", org.title)
user.active_organization = org
user.save()

project = Project.objects.filter(title="FFmpeg Frame Alignment Demo", organization=org).first()
if project is None:
    project = Project.objects.create(
        title="FFmpeg Frame Alignment Demo",
        organization=org,
        created_by=user,
        label_config=LABEL_CONFIG,
    )
    print("created project", project.id, project.title)
else:
    print("project already exists", project.id)

for title, rel in VIDEOS:
    url = f"/data/local-files/?d={rel}"
    if not Task.objects.filter(project=project, data__video=url).exists():
        Task.objects.create(project=project, data={"video": url, "label": title})
        print("created task:", title, "->", url)
    else:
        print("task exists:", title)

print("\n=== DONE ===")
print("login:", EMAIL, "/", PASSWORD)
print("project id:", project.id)
print("tasks:", Task.objects.filter(project=project).count())
