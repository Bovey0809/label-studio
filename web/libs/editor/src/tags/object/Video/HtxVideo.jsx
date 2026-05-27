import { observer } from "mobx-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VideoIndexLoader } from "../../../lib/VideoIndex/VideoIndexLoader";
import { VideoIndexCache } from "../../../lib/VideoIndex/VideoIndexCache";

import { IconZoomIn } from "@humansignal/icons";
import { Button } from "@humansignal/ui";
import { Dropdown } from "../../../common/Dropdown/Dropdown";
import { Menu } from "../../../common/Menu/Menu";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage";
import ObjectTag from "../../../components/Tags/Object";
import { VideoConfigControl } from "../../../components/Timeline/Controls/VideoConfigControl";
import { Timeline } from "../../../components/Timeline/Timeline";
import { clampZoom, VideoCanvas } from "../../../components/VideoCanvas/VideoCanvas";
import {
  MAX_ZOOM_WHEEL,
  MIN_ZOOM_WHEEL,
  ZOOM_STEP,
  ZOOM_STEP_WHEEL,
} from "../../../components/VideoCanvas/VideoConstants";
import { defaultStyle } from "../../../core/Constants";
import { useFullscreen } from "../../../hooks/useFullscreen";
import { useToggle } from "../../../hooks/useToggle";
import { Block, Elem } from "../../../utils/bem";
import ResizeObserver from "../../../utils/resize-observer";
import { clamp, isDefined } from "../../../utils/utilities";
import "./Video.scss";
import { VideoRegions } from "./VideoRegions";
import { ff } from "@humansignal/core";

const isSyncedBuffering = ff.isActive(ff.FF_SYNCED_BUFFERING);

// Shared IndexedDB-backed cache so re-opening a video shows its ffmpeg index
// instantly (no network round-trip). Keyed by video URL; revalidated in the
// background so a re-indexed video self-heals. Guarded for environments
// without IndexedDB (returns undefined -> loader just skips caching).
let _videoIndexCache = null;
function getVideoIndexCacheAdapter() {
  if (typeof indexedDB === "undefined") return undefined;
  try {
    if (!_videoIndexCache) _videoIndexCache = new VideoIndexCache();
    const cache = _videoIndexCache;
    return {
      get: (url) => cache.getByUrl(url),
      put: (url, payload) => cache.putByUrl(url, payload),
    };
  } catch {
    return undefined;
  }
}

function useZoom(videoDimensions, canvasDimentions, shouldClampPan) {
  const [zoomState, setZoomState] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  const data = useRef({});

  data.current.video = videoDimensions;
  data.current.canvas = canvasDimentions;
  data.current.shouldClampPan = shouldClampPan;

  const clampPan = useCallback((pan, zoom) => {
    if (!shouldClampPan) {
      return pan;
    }
    const xMinMax = clamp(
      (data.current.video.width * zoom - data.current.canvas.width) / 2,
      0,
      Number.POSITIVE_INFINITY,
    );
    const yMinMax = clamp(
      (data.current.video.height * zoom - data.current.canvas.height) / 2,
      0,
      Number.POSITIVE_INFINITY,
    );

    return {
      x: clamp(pan.x, -xMinMax, xMinMax),
      y: clamp(pan.y, -yMinMax, yMinMax),
    };
  }, []);

  const setZoomAndPan = useCallback((value) => {
    return setZoomState((prevState) => {
      const nextState = value instanceof Function ? value(prevState) : value;
      const { zoom: prevZoom, pan: prevPan } = prevState;
      const nextZoom = clampZoom(nextState.zoom);

      if (nextZoom === prevZoom) {
        return prevState;
      }

      if (nextZoom === nextState.zoom) {
        return {
          zoom: nextState.zoom,
          pan: clampPan(nextState.pan, nextState.zoom),
        };
      }

      const scale = (nextZoom - prevZoom) / (nextState.zoom - prevZoom);
      const nextPan = {
        x: prevPan.x + (nextState.pan.x - prevPan.x) * scale,
        y: prevPan.y + (nextState.pan.y - prevPan.y) * scale,
      };

      return {
        pan: clampPan(nextPan, nextZoom),
        zoom: nextZoom,
      };
    });
  }, []);

  const setZoom = useCallback((value) => {
    return setZoomState(({ zoom, pan }) => {
      const nextZoom = clampZoom(value instanceof Function ? value(zoom) : value);

      return {
        zoom: nextZoom,
        pan: {
          x: (pan.x / zoom) * nextZoom,
          y: (pan.y / zoom) * nextZoom,
        },
      };
    });
  }, []);

  const setPan = useCallback((pan) => {
    return setZoomState((currentState) => {
      pan = pan instanceof Function ? pan(currentState.pan) : pan;
      return {
        ...currentState,
        pan,
      };
    });
  }, []);

  return [zoomState, { setZoomAndPan, setZoom, setPan }];
}

const VideoConfig = observer(({ item }) => {
  const [isConfigModalActive, setIsConfigModalActive] = useState(false);

  return (
    <VideoConfigControl
      configModal={isConfigModalActive}
      onSetModal={setIsConfigModalActive}
      speed={item.speed}
      onSpeedChange={item.handleSpeed}
      loopTimelineRegion={item.loopTimelineRegion}
      onLoopTimelineRegionChange={item.setLoopTimelineRegion}
      minSpeed={item.minplaybackspeed}
    />
  );
});

const HtxVideoView = ({ item, store }) => {
  if (!item._value) return null;

  const limitCanvasDrawingBoundaries = !store.settings.videoDrawOutside;
  const videoBlockRef = useRef();
  const stageRef = useRef();
  const videoContainerRef = useRef();
  const mainContentRef = useRef();
  const [loaded, setLoaded] = useState(false);
  // Only surface the "Preparing video index…" banner if it's actually taking a
  // moment — fast/cached/pre-warmed indexes resolve well under this delay, so
  // the banner never flashes for them.
  const [showPreparing, setShowPreparing] = useState(false);
  const [videoLength, _setVideoLength] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, _setPosition] = useState(1);

  const [videoSize, setVideoSize] = useState(null);
  const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0, ratio: 1 });
  const [{ zoom, pan }, { setZoomAndPan, setZoom, setPan }] = useZoom(
    videoDimensions,
    item.ref.current
      ? {
          width: item.ref.current.width,
          height: item.ref.current.height,
        }
      : { width: 0, height: 0 },
    limitCanvasDrawingBoundaries,
  );
  const [panMode, setPanMode] = useState(false);
  const [isFullScreen, enterFullscreen, exitFullscren, handleFullscreenToggle] = useToggle(false);
  const fullscreen = useFullscreen({
    onEnterFullscreen() {
      enterFullscreen();
    },
    onExitFullscreen() {
      exitFullscren();
    },
  });

  const setPosition = useCallback(
    (value) => {
      if (value !== position && videoLength) {
        const nextPosition = clamp(value, 1, videoLength);

        _setPosition(nextPosition);
      }
    },
    [position, videoLength],
  );

  const setVideoLength = useCallback(
    (value) => {
      if (value !== videoLength) _setVideoLength(value);
    },
    [videoLength],
  );

  const supportsRegions = useMemo(() => {
    return isDefined(item?.videoControl);
  }, [item]);

  const supportsTimelineRegions = useMemo(() => {
    return isDefined(item?.timelineControl);
  }, [item]);

  useEffect(() => {
    const container = videoContainerRef.current;

    const cancelWheel = (e) => {
      if (!e.shiftKey) return;
      e.preventDefault();
    };

    container.addEventListener("wheel", cancelWheel);

    return () => container.removeEventListener("wheel", cancelWheel);
  }, []);

  useEffect(() => {
    const onResize = () => {
      const block = videoContainerRef.current;

      if (block) {
        setVideoSize([block.clientWidth, block.clientHeight]);
      }
    };

    const onKeyDown = (e) => {
      if (e.code.startsWith("Shift")) {
        e.preventDefault();

        if (!panMode) {
          setPanMode(true);

          const cancelPan = (e) => {
            if (e.code.startsWith("Shift")) {
              setPanMode(false);
              document.removeEventListener("keyup", cancelPan);
            }
          };

          document.addEventListener("keyup", cancelPan);
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);

    const observer = new ResizeObserver(() => onResize());
    const [vContainer, vBlock] = [videoContainerRef.current, videoBlockRef.current];

    observer.observe(vContainer);
    observer.observe(vBlock);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      observer.unobserve(vContainer);
      observer.unobserve(vBlock);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const fullscreenElement = fullscreen.getElement();

    if (isFullScreen && !fullscreenElement) {
      fullscreen.enter(mainContentRef.current);
    } else if (!isFullScreen && fullscreenElement) {
      fullscreen.exit();
    }
  }, [isFullScreen]);

  const onZoomChange = useCallback((e) => {
    if (!e.shiftKey || !stageRef.current) return;
    // because its possible the shiftKey is the modifier, we need to check the appropriate delta
    const wheelDelta = Math.abs(e.deltaY) === 0 ? e.deltaX : e.deltaY;
    const polarity = wheelDelta > 0 ? 1 : -1;
    const stepDelta = Math.abs(wheelDelta * ZOOM_STEP_WHEEL);
    const delta = polarity * clamp(stepDelta, MIN_ZOOM_WHEEL, MAX_ZOOM_WHEEL);

    requestAnimationFrame(() => {
      setZoomAndPan(({ zoom, pan }) => {
        const nextZoom = zoom + delta;
        const scale = nextZoom / zoom;

        const pointerPos = {
          x: stageRef.current.pointerPos.x - item.ref.current.width / 2,
          y: stageRef.current.pointerPos.y - item.ref.current.height / 2,
        };

        return {
          zoom: nextZoom,
          pan: {
            x: pan.x * scale + pointerPos.x * (1 - scale),
            y: pan.y * scale + pointerPos.y * (1 - scale),
          },
        };
      });
    });
  }, []);

  const handlePan = useCallback(
    (e) => {
      if (!panMode) return;

      const startX = e.pageX;
      const startY = e.pageY;

      const onMouseMove = (e) => {
        const position = item.ref.current.adjustPan(pan.x + (e.pageX - startX), pan.y + (e.pageY - startY));

        requestAnimationFrame(() => {
          setPan(position);
        });
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [panMode, pan],
  );

  const zoomIn = useCallback(() => {
    setZoom((zoom) => zoom + ZOOM_STEP);
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((zoom) => zoom - ZOOM_STEP);
  }, []);

  const zoomToFit = useCallback(() => {
    setZoomAndPan({
      zoom: item.ref.current.videoDimensions.ratio,
      pan: { x: 0, y: 0 },
    });
  }, []);

  const zoomReset = useCallback(() => {
    setZoomAndPan({
      zoom: 1,
      pan: { x: 0, y: 0 },
    });
  }, []);

  // VIDEO EVENT HANDLERS
  const handleFrameChange = useCallback(
    (position, length) => {
      setPosition(position);
      setVideoLength(length);
      item.setOnlyFrame(position);
    },
    [item, setPosition, setVideoLength],
  );

  const handleVideoLoad = useCallback(
    ({ length, videoDimensions }) => {
      setLoaded(true);
      setZoom(videoDimensions.ratio);
      setVideoDimensions(videoDimensions);
      // The ffmpeg index is authoritative for the frame count; the canvas may have
      // computed `length` from the framerate fallback before the index was ready.
      const effectiveLength = item.index ? item.index.length : length;
      setVideoLength(effectiveLength);
      item.setOnlyFrame(1);
      item.setLength(effectiveLength);
      item.setReady(true);
    },
    [item, setVideoLength],
  );

  const handleVideoResize = useCallback((videoDimensions) => {
    setVideoDimensions(videoDimensions);
  }, []);

  const handleVideoEnded = useCallback(() => {
    setPlaying(false);
    setPosition(videoLength);
  }, [videoLength, setPosition, setPlaying]);

  // TIMELINE EVENT HANDLERS
  const handlePlay = useCallback(() => {
    setPlaying((_playing) => {
      if (!item.ref.current.playing) {
        // @todo item.ref.current.playing? could be buffering and other states
        item.ref.current.play();
        item.triggerSyncPlay();
      }
      return true;
    });
  }, [item]);

  const handlePause = useCallback(() => {
    setPlaying((_playing) => {
      if (item.ref.current.playing) {
        item.ref.current.pause();
        item.triggerSyncPause();
      }
      return false;
    });
  }, []);

  const handlePlayClick = useCallback(() => {
    if (isSyncedBuffering && item.isBuffering) {
      item.triggerSyncPlay(true);
    } else {
      handlePlay();
    }
  }, []);

  const handlePauseClick = useCallback(() => {
    if (isSyncedBuffering && item.isBuffering) {
      item.triggerSyncPause(true);
    } else {
      handlePause();
    }
  });

  const handleSelectRegion = useCallback(
    (_, id, select) => {
      const region = item.findRegion(id);
      const selected = region?.selected || region?.inSelection;

      if (!region || (isDefined(select) && selected === select)) return;

      region.onClickRegion();
    },
    [item],
  );

  const handleAction = useCallback(
    (_, action, data) => {
      const regions = item.regs.filter((reg) => reg.selected || reg.inSelection);

      regions.forEach((region) => {
        switch (action) {
          case "lifespan_add":
          case "lifespan_remove":
            region.toggleLifespan(data.frame);
            break;
          case "keypoint_add":
            region.addKeypoint(data.frame);
            break;
          case "keypoint_remove":
            region.removeKeypoint(data.frame);
            break;
          default:
            console.warn("unknown action");
        }
      });
    },
    [item.regs],
  );

  const handleTimelinePositionChange = useCallback(
    (newPosition) => {
      if (position !== newPosition) {
        item.setFrame(newPosition);
        setPosition(newPosition);
      }
    },
    [item, position],
  );

  useEffect(
    () => () => {
      item.ref.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!item || !item._value) return;
    if (item.indexStatus !== "idle") return;
    item.setIndexStatus("loading");
    const transport = {
      async get() {
        const r = await fetch(`/api/video-index/?url=${encodeURIComponent(item._value)}`);
        return { status: r.status, body: await r.json().catch(() => ({})) };
      },
      async post(body) {
        const r = await fetch(`/api/video-index/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      },
    };
    const loader = new VideoIndexLoader({
      transport,
      cache: getVideoIndexCacheAdapter(),
      // Background revalidation found a newer index than the cached one — re-apply it.
      onRevalidated: (idx) => item.setIndex(idx),
    });
    loader.load({ videoUrl: item._value })
      .then((idx) => item.setIndex(idx))
      .catch((err) => {
        console.warn("[Video] index load failed:", err);
        item.setIndexStatus("failed");
      });
  }, [item, item?._value]);

  // Delay the "Preparing…" banner so fast/cached index loads don't flash it.
  useEffect(() => {
    const preparing = item.indexStatus === "loading" || item.indexStatus === "idle";
    if (!preparing) {
      setShowPreparing(false);
      return;
    }
    const timer = setTimeout(() => setShowPreparing(true), 250);
    return () => clearTimeout(timer);
  }, [item.indexStatus]);

  const regions = item.regs.map((reg) => {
    const color = reg.style?.fillcolor ?? reg.tag?.fillcolor ?? defaultStyle.fillcolor;
    const label = reg.labels.join(", ") || "Empty";
    const timeline = reg.type.includes("timeline");
    const sequence = reg.sequence;

    return {
      id: reg.cleanId,
      index: reg.region_index,
      label,
      color,
      visible: !reg.hidden,
      selected: reg.selected || reg.inSelection,
      sequence,
      timeline,
      locked: reg.locked,
    };
  });

  // new Timeline Regions are added at the top of timeline, so we have to reverse the order
  if (item.timelineControl) regions.reverse();

  // when label is selected and user is ready to draw a new region, we create a labeled empty line at the top
  if (item.timelineControl?.selectedLabels?.length && !item.annotation.selectionSize && !item.drawingRegion) {
    const label = item.timelineControl.selectedLabels[0];
    regions.unshift({
      id: "new",
      label: label.value,
      color: label.background,
      visible: true,
      selected: true,
      sequence: [],
      timeline: true,
    });
  }

  return (
    <ObjectTag item={item}>
      <Block name="video-segmentation" ref={mainContentRef} mod={{ fullscreen: isFullScreen }}>
        {item.errors?.map((error, i) => (
          <ErrorMessage key={`err-${i}`} error={error} />
        ))}

        <Block name="video" mod={{ fullscreen: isFullScreen }} ref={videoBlockRef}>
          <Elem
            name="main"
            ref={videoContainerRef}
            style={{ height: Number(item.height) }}
            onMouseDown={handlePan}
            onWheel={onZoomChange}
          >
            {showPreparing ? (
              <div className="lsf-video-preparing" aria-live="polite">Preparing video index…</div>
            ) : null}
            {videoSize && (
              <>
                {loaded && supportsRegions && (
                  <VideoRegions
                    item={item}
                    zoom={zoom}
                    pan={pan}
                    locked={panMode}
                    regions={item.regs}
                    width={videoSize[0]}
                    height={videoSize[1]}
                    workingArea={videoDimensions}
                    allowRegionsOutsideWorkingArea={!limitCanvasDrawingBoundaries}
                    stageRef={stageRef}
                  />
                )}
                <VideoCanvas
                  ref={item.ref}
                  src={item._value}
                  index={item.index}
                  width={videoSize[0]}
                  height={videoSize[1]}
                  muted={item.muted}
                  zoom={zoom}
                  pan={pan}
                  speed={item.speed}
                  framerate={item.framerate}
                  buffering={item.isBuffering}
                  allowInteractions={false}
                  allowPanOffscreen={!limitCanvasDrawingBoundaries}
                  onFrameChange={handleFrameChange}
                  onLoad={handleVideoLoad}
                  onResize={handleVideoResize}
                  // onClick={togglePlaying}
                  onEnded={handleVideoEnded}
                  onPlay={handlePlay}
                  onPause={handlePause}
                  onSeeked={item.handleSeek}
                  onBuffering={item.handleBuffering}
                  loopFrameRange={item.loopTimelineRegion}
                  selectedFrameRange={item.selectedFrameRange}
                />
              </>
            )}
          </Elem>
        </Block>

        {loaded && (
          <Elem
            name="timeline"
            tag={Timeline}
            playing={isSyncedBuffering && item.isBuffering ? item.wasPlayingBeforeBuffering : playing}
            buffering={isSyncedBuffering ? item.isBuffering : false}
            length={videoLength}
            position={position}
            regions={regions}
            height={item.timelineheight}
            altHopSize={store.settings.videoHopSize}
            allowFullscreen={false}
            fullscreen={isFullScreen}
            defaultStepSize={16}
            disableView={!supportsTimelineRegions && !supportsRegions}
            framerate={item.framerate}
            controls={{ FramesControl: true }}
            readonly={item.annotation?.isReadOnly()}
            customControls={[
              {
                position: "left",
                component: () => {
                  return (
                    <>
                      <VideoConfig item={item} />
                      <Dropdown.Trigger
                        key="dd"
                        inline={isFullScreen}
                        content={
                          <Menu size="auto" closeDropdownOnItemClick={false}>
                            <Menu.Item onClick={zoomIn}>Zoom In</Menu.Item>
                            <Menu.Item onClick={zoomOut}>Zoom Out</Menu.Item>
                            <Menu.Item onClick={zoomToFit}>Zoom To Fit</Menu.Item>
                            <Menu.Item onClick={zoomReset}>Zoom 100%</Menu.Item>
                          </Menu>
                        }
                      >
                        <Button size="small" variant="neutral" look="string">
                          <IconZoomIn />
                        </Button>
                      </Dropdown.Trigger>
                    </>
                  );
                },
              },
            ]}
            onPositionChange={handleTimelinePositionChange}
            onPlay={handlePlayClick}
            onPause={handlePauseClick}
            onFullscreenToggle={handleFullscreenToggle}
            onSelectRegion={handleSelectRegion}
            onStartDrawing={item.startDrawing}
            onFinishDrawing={item.finishDrawing}
            onAction={handleAction}
          />
        )}
      </Block>
    </ObjectTag>
  );
};

export { HtxVideoView };
