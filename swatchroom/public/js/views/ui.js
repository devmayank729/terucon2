// Small shared UI pieces: spinner, dialog, toasts, segmented control, menu, bottom sheet,
// and the layout measurement.
import { cx, h, live, update } from "../core/dom.js";
import { icon } from "../core/icons.js";

export function spinner(size, className) {
  return icon("loader-circle", size || 16, {
    class: "sr-spin" + (className ? " " + className : ""),
  });
}

// Native <dialog> with a title bar. On phones the CSS turns it into a sheet from the bottom.
// options: { key, open, title, titleId, size, onClose, body (nodes) }
export function modal(options) {
  return h(
    "dialog",
    {
      key: options.key || options.titleId,
      class: cx("sr-modal", options.size && "sr-modal-" + options.size),
      "aria-labelledby": options.titleId,
      onclose: options.onClose,
      oncancel: function (event) {
        event.preventDefault();
        options.onClose();
      },
      onclick: function (event) {
        if (event.target === event.currentTarget) {
          options.onClose();
        }
      },
      ref: function (dialog) {
        if (options.open && !dialog.open) {
          try {
            dialog.showModal();
          } catch (error) {
            dialog.setAttribute("open", "");
          }
        }
        if (!options.open && dialog.open) {
          dialog.close();
        }
      },
    },
    options.open
      ? h(
          "div",
          { class: "sr-modal-body" },
          h(
            "div",
            { class: "sr-modal-head" },
            h(
              "h2",
              { id: options.titleId, class: "sr-modal-title" },
              options.title,
            ),
            h(
              "button",
              {
                type: "button",
                class: "sr-icon-button",
                "aria-label": "Close",
                onclick: options.onClose,
              },
              icon("x", 20),
            ),
          ),
          options.body,
        )
      : null,
  );
}

const TOAST_ICONS = {
  error: "circle-alert",
  success: "circle-check",
  info: "info",
};

export function toasts(list, onDismiss) {
  if (list.length === 0) {
    return null;
  }
  return h(
    "div",
    { class: "sr-toasts" },
    list.map(function (toast) {
      const isError = toast.tone === "error";
      return h(
        "div",
        {
          key: "toast-" + toast.id,
          class: "sr-toast sr-toast-" + toast.tone,
          role: isError ? "alert" : "status",
        },
        icon(TOAST_ICONS[toast.tone] || "info", 18),
        h("p", null, toast.message),
        toast.action
          ? h(
              "button",
              {
                type: "button",
                class: "sr-link-button",
                onclick: function () {
                  toast.action.run();
                  onDismiss(toast.id);
                },
              },
              toast.action.label,
            )
          : null,
        h(
          "button",
          {
            type: "button",
            class: "sr-icon-button sr-icon-button-small",
            "aria-label": "Dismiss message",
            onclick: function () {
              onDismiss(toast.id);
            },
          },
          icon("x", 14),
        ),
      );
    }),
  );
}

// options: { label, value, onChange, options: [{ value, label, title, disabled }], className }
export function segmented(options) {
  return h(
    "div",
    {
      class: cx("sr-segmented", options.className),
      role: "radiogroup",
      "aria-label": options.label,
    },
    options.options.map(function (option) {
      const active = option.value === options.value;
      return h(
        "button",
        {
          key: String(option.value),
          type: "button",
          role: "radio",
          "aria-checked": active ? "true" : "false",
          class: cx("sr-segment", active && "is-active"),
          title: option.title || null,
          disabled: !!option.disabled,
          onclick: function () {
            options.onChange(option.value);
          },
        },
        option.label,
      );
    }),
  );
}

// A popover menu. The studio keeps which menu is open; items:
// { label, icon, onSelect, disabled, danger, hidden, hint, divider }
export function menu(options) {
  const items = options.items.filter(function (item) {
    return !item.hidden;
  });
  return h(
    "div",
    { class: "sr-menu", "data-menu": options.id },
    h(
      "button",
      {
        type: "button",
        class: options.buttonClass || "sr-icon-button",
        "aria-label": options.label,
        "aria-haspopup": "menu",
        "aria-expanded": options.open ? "true" : "false",
        onclick: function () {
          options.onToggle(!options.open);
        },
      },
      options.icon,
      options.text || null,
    ),
    options.open
      ? h(
          "div",
          {
            class: cx("sr-menu-list", options.align === "left" && "is-left"),
            role: "menu",
          },
          items.map(function (item) {
            if (item.divider) {
              return h("div", {
                key: item.key || "divider",
                class: "sr-menu-divider",
                role: "separator",
              });
            }
            return h(
              "button",
              {
                key: item.label,
                type: "button",
                role: "menuitem",
                class: cx("sr-menu-item", item.danger && "is-danger"),
                disabled: !!item.disabled,
                onclick: function () {
                  options.onToggle(false);
                  item.onSelect();
                },
              },
              item.icon || null,
              h("span", null, item.label),
              item.hint ? h("kbd", null, item.hint) : null,
            );
          }),
        )
      : null,
  );
}

// Layout by the studio's own size (not the window), so it works inside any page.
//   wide    three columns (surfaces | photo | finishes)
//   medium  photo + side panel
//   narrow  photo + bottom sheet (phones, and tablets held upright)
export function measureLayout(element) {
  const rect = element.getBoundingClientRect();
  let mode = "wide";
  const portrait = rect.height > rect.width * 1.15;
  if (rect.width < 720 || (rect.width < 1100 && portrait)) {
    mode = "narrow";
  } else if (rect.width < 1100) {
    mode = "medium";
  }
  return { mode: mode, width: rect.width, height: rect.height };
}

export function isCoarsePointer() {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch (error) {
    return false;
  }
}

// Drag-to-resize bottom sheet for phones, with two resting heights: peek and full.
// Think of a drawer: pull it up for everything, push it down to see the photo.
export class BottomSheet {
  constructor() {
    this.element = live(h("section", { class: "sr-sheet" }));
    this.props = null;
    this.drag = null;
    this.toggledAt = 0;
    const sheet = this;
    this.onPointerDown = function (event) {
      sheet.pointerDown(event);
    };
    this.onPointerMove = function (event) {
      sheet.pointerMove(event);
    };
    this.onPointerUp = function (event) {
      sheet.pointerUp(event);
    };
  }

  height() {
    if (this.drag && this.drag.height !== null) {
      return this.drag.height;
    }
    return this.props.expanded ? this.props.fullHeight : this.props.peekHeight;
  }

  // props: { label, expanded, peekHeight, fullHeight, header, body, footer, onExpandedChange }
  update(props) {
    this.props = props;
    const sheet = this;
    this.element.className = cx(
      "sr-sheet",
      this.drag && this.drag.moved && "is-dragging",
      props.expanded && "is-expanded",
    );
    this.element.style.height = this.height() + "px";
    this.element.setAttribute("aria-label", props.label);
    update(this.element, [
      h(
        "div",
        {
          class: "sr-sheet-handle",
          onpointerdown: this.onPointerDown,
          onpointermove: this.onPointerMove,
          onpointerup: this.onPointerUp,
          onpointercancel: this.onPointerUp,
        },
        h(
          "button",
          {
            type: "button",
            class: "sr-sheet-grabber",
            "aria-label": props.expanded ? "Show less" : "Show more",
            "aria-expanded": props.expanded ? "true" : "false",
            onclick: function () {
              // keyboard activation; taps are handled in pointerUp
              if (performance.now() - sheet.toggledAt > 400) {
                props.onExpandedChange(!props.expanded);
              }
            },
          },
          h("span"),
        ),
        props.header,
      ),
      h("div", { class: "sr-sheet-content" }, props.body),
      props.footer ? h("div", { class: "sr-sheet-foot" }, props.footer) : null,
    ]);
  }

  pointerDown(event) {
    if (event.button !== 0 && event.pointerType === "mouse") {
      return;
    }
    const onGrabber = !!event.target.closest(".sr-sheet-grabber");
    if (
      event.target.closest("button, input, select, textarea, a, label") &&
      !onGrabber
    ) {
      return;
    }
    this.drag = {
      startY: event.clientY,
      startHeight: this.height(),
      lastY: event.clientY,
      lastTime: performance.now(),
      velocity: 0,
      moved: false,
      height: null,
      fromGrabber: onGrabber,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      // capture is optional
    }
  }

  pointerMove(event) {
    const drag = this.drag;
    if (!drag) {
      return;
    }
    const delta = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(delta) < 6) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      this.element.classList.add("is-dragging");
    }
    const now = performance.now();
    drag.velocity =
      (drag.lastY - event.clientY) / Math.max(1, now - drag.lastTime);
    drag.lastY = event.clientY;
    drag.lastTime = now;
    drag.height = Math.max(
      this.props.peekHeight * 0.6,
      Math.min(this.props.fullHeight, drag.startHeight + delta),
    );
    // Only the height changes while dragging; the rest of the studio does not redraw.
    this.element.style.height = drag.height + "px";
  }

  pointerUp() {
    const drag = this.drag;
    this.drag = null;
    if (!drag) {
      return;
    }
    this.element.classList.remove("is-dragging");
    if (!drag.moved) {
      if (drag.fromGrabber) {
        this.toggledAt = performance.now();
        this.props.onExpandedChange(!this.props.expanded);
      }
      return;
    }
    const current = drag.height !== null ? drag.height : this.height();
    const middle = (this.props.peekHeight + this.props.fullHeight) / 2;
    let expand = current > middle;
    if (drag.velocity > 0.45) {
      expand = true;
    }
    if (drag.velocity < -0.45) {
      expand = false;
    }
    if (expand === this.props.expanded) {
      this.element.style.height = this.height() + "px";
    }
    this.props.onExpandedChange(expand);
  }
}
