// Before a photo is loaded: add a photo (file, drag and drop, or camera) or reopen a saved room.
import { cx, h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { spinner } from "./ui.js";

// A room that was never rendered, or whose photo upload was cut short, has no thumbnail, and every re-render of this
// list builds its <img> again. A miss is remembered for a while so the list asks the server once, not once per hover.
const THUMB_RETRY_MS = 30000;
const missingThumbs = new Map();

function thumbKnownMissing(roomId) {
  const missedAt = missingThumbs.get(roomId);
  if (missedAt === undefined) {
    return false;
  }
  if (Date.now() - missedAt > THUMB_RETRY_MS) {
    missingThumbs.delete(roomId);
    return false;
  }
  return true;
}

function when(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return (
      "Today, " +
      date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
  }
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// props: coarse, roomsOnly, rooms, roomsState ("loading" | "ready" | "error"), roomsError,
// thumbUrl(roomId), onFile, onPick, onCamera, onOpenRoom, onDeleteRoom, dragging, onDragging,
// openingId
export function emptyStage(props) {
  const rooms = props.rooms || [];
  let recent = null;
  if (rooms.length > 0) {
    recent = h(
      "section",
      {
        class: "sr-recent",
        "aria-labelledby": props.roomsOnly ? null : "sr-recent-title",
      },
      !props.roomsOnly
        ? h(
            "h2",
            { id: "sr-recent-title", class: "sr-recent-title" },
            "Continue a room",
          )
        : null,
      h(
        "ul",
        { class: "sr-recent-list" },
        rooms.map(function (room) {
          const opening = props.openingId === room.id;
          return h(
            "li",
            { key: room.id, class: "sr-recent-item" },
            h(
              "button",
              {
                type: "button",
                class: "sr-recent-open",
                disabled: !!props.openingId,
                onclick: function () {
                  props.onOpenRoom(room.id);
                },
              },
              h(
                "span",
                { class: "sr-recent-thumb" },
                thumbKnownMissing(room.id)
                  ? null
                  : h("img", {
                      src: props.thumbUrl(room.id),
                      alt: "",
                      loading: "lazy",
                      onload: function () {
                        missingThumbs.delete(room.id);
                      },
                      onerror: function (event) {
                        missingThumbs.set(room.id, Date.now());
                        event.target.style.visibility = "hidden";
                      },
                    }),
              ),
              h(
                "span",
                { class: "sr-recent-text" },
                h("strong", { class: "sr-truncate" }, room.name),
                h(
                  "span",
                  null,
                  opening
                    ? "Opening…"
                    : when(room.updatedAt) +
                        ", " +
                        room.versionCount +
                        " version" +
                        (room.versionCount === 1 ? "" : "s"),
                ),
              ),
              opening ? spinner(16) : null,
            ),
            h(
              "button",
              {
                type: "button",
                class: "sr-icon-button",
                "aria-label": "Delete " + room.name,
                onclick: function () {
                  props.onDeleteRoom(room.id);
                },
              },
              icon("trash-2", 16),
            ),
          );
        }),
      ),
    );
  } else if (props.roomsState === "error" && !props.roomsOnly) {
    recent = h(
      "p",
      { class: "sr-recent-note" },
      "Saved rooms could not be loaded: " + props.roomsError,
    );
  }
  return h(
    "div",
    { class: cx("sr-empty", props.roomsOnly && "is-rooms-only") },
    !props.roomsOnly
      ? h(
          "div",
          {
            class: cx("sr-photo-drop", props.dragging && "is-dragging"),
            ondragover: function (event) {
              event.preventDefault();
              event.stopPropagation();
              if (!props.dragging) {
                props.onDragging(true);
              }
            },
            ondragleave: function () {
              props.onDragging(false);
            },
            ondrop: function (event) {
              event.preventDefault();
              event.stopPropagation();
              props.onDragging(false);
              props.onFile(
                event.dataTransfer.files && event.dataTransfer.files[0],
              );
            },
          },
          icon("image-plus", 32, { strokeWidth: 1.3 }),
          h("h1", { class: "sr-photo-drop-title" }, "Add a room photo"),
          h(
            "p",
            { class: "sr-photo-drop-sub" },
            "Stand in a corner at chest height so the floor, the ceiling and at least two walls are in frame. Landscape works best.",
          ),
          h(
            "div",
            { class: "sr-photo-drop-actions" },
            props.coarse
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "sr-button sr-button-primary",
                    onclick: props.onCamera,
                  },
                  icon("camera", 17),
                  " Take a photo",
                )
              : null,
            h(
              "button",
              {
                type: "button",
                class:
                  "sr-button " +
                  (props.coarse ? "sr-button-quiet" : "sr-button-primary"),
                onclick: props.onPick,
              },
              icon("image-plus", 17),
              props.coarse ? " Choose from gallery" : " Choose a photo",
            ),
          ),
          !props.coarse
            ? h(
                "p",
                { class: "sr-photo-drop-hint" },
                "or drop a JPG, PNG or WebP here",
              )
            : null,
        )
      : null,
    recent,
  );
}
