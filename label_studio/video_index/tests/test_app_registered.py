from django.apps import apps


def test_video_index_app_is_installed():
    assert apps.is_installed("video_index")


def test_video_index_app_config_label():
    config = apps.get_app_config("video_index")
    assert config.name == "video_index"
