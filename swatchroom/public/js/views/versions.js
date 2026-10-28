// Strip of versions under the photo (or in a dialog on phones).
import { cx, h } from "../core/dom.js";
import { icon } from "../core/icons.js";

// Scroll the current version into view (called after the page updates).
export function revealCurrentVersion(root) {
  const lists = root.querySelectorAll(".sr-film-list");
  lists.forEach(function (list) {
    const current = list.querySelector(".sr-film.is-current");
    if (!current) {
      return;
    }
    const listRect = list.getBoundingClientRect();
    const itemRect = current.getBoundingClientRect();
    if (itemRect.left < listRect.left || itemRect.right > listRect.right) {
      list.scrollBy({
        left:
          itemRect.left - listRect.left - (listRect.width - itemRect.width) / 2,
        behavior: "smooth",
      });
    }
  });
}

// props: versions, currentId, displayUrl, onSelect, onShare, canShareFiles, inSheet
export function versionsStrip(props) {
  return h(
    "div",
    { class: cx("sr-filmstrip", props.inSheet && "is-in-sheet") },
    h(
      "ol",
      { class: "sr-film-list", "aria-label": "Versions" },
      props.versions.map(function (version) {
        const current = version.id === props.currentId;
        return h(
          "li",
          { key: version.id },
          h(
            "button",
            {
              type: "button",
              class: cx("sr-film", current && "is-current"),
              "aria-current": current ? "true" : null,
              title: version.isOriginal
                ? "Original photo"
                : version.title + " on " + version.subtitle,
              onclick: function () {
                props.onSelect(version.id);
              },
            },
            h("img", {
              src: props.displayUrl(version),
              alt: "",
              class: "sr-film-thumb",
              draggable: "false",
              loading: "lazy",
            }),
            h(
              "span",
              { class: "sr-film-text" },
              h(
                "span",
                { class: "sr-film-number" },
                version.isOriginal ? "Original" : "v" + version.number,
              ),
              h(
                "span",
                { class: "sr-film-title sr-truncate" },
                version.isOriginal ? "As photographed" : version.title,
              ),
            ),
          ),
        );
      }),
    ),
    !props.inSheet
      ? h(
          "div",
          { class: "sr-film-actions" },
          h(
            "button",
            {
              type: "button",
              class: "sr-button sr-button-quiet",
              onclick: props.onShare,
            },
            icon(props.canShareFiles ? "share-2" : "download", 16),
            props.canShareFiles ? " Share" : " Export",
          ),
        )
      : null,
  );
}
