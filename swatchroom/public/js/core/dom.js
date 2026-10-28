// A small helper for building and updating the page with plain DOM.
//
//   h("button", { class: "sr-button", onclick: save }, "Save")
//
// builds a real element. update(container, children) then makes the live page match the new
// elements, changing only what differs: like correcting a printed page with a pen instead of
// reprinting it, so text boxes keep their focus and lists keep their scroll position.
//
// Props:
//   class, style (string or object), on<event> (a function, e.g. onclick, oninput),
//   key (keeps an element matched to the same item when lists reorder),
//   ref (a function called with the live element after each update),
//   html (trusted markup, e.g. an SVG swatch, written with innerHTML only when it changes),
//   value, checked, selected, disabled, indeterminate (set as properties),
//   anything else becomes an attribute; true is an empty attribute, false/null/undefined skip it.

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = {
  svg: true,
  path: true,
  circle: true,
  rect: true,
  line: true,
  polyline: true,
  polygon: true,
  g: true,
  ellipse: true,
};
const PROPERTY_NAMES = {
  value: true,
  checked: true,
  selected: true,
  indeterminate: true,
};
const UNITLESS = {
  opacity: true,
  zIndex: true,
  flex: true,
  flexGrow: true,
  flexShrink: true,
  fontWeight: true,
  lineHeight: true,
  order: true,
};

let refQueue = [];

function kebab(name) {
  return name.replace(/[A-Z]/g, function (letter) {
    return "-" + letter.toLowerCase();
  });
}

function styleText(style) {
  if (typeof style === "string") {
    return style;
  }
  const parts = [];
  Object.keys(style).forEach(function (name) {
    const value = style[name];
    if (
      value === null ||
      value === undefined ||
      value === false ||
      value === ""
    ) {
      return;
    }
    const cssName = name.indexOf("--") === 0 ? name : kebab(name);
    let cssValue = value;
    if (
      typeof value === "number" &&
      !UNITLESS[name] &&
      name.indexOf("--") !== 0
    ) {
      cssValue = value + "px";
    }
    parts.push(cssName + ": " + cssValue);
  });
  return parts.join("; ");
}

function addChildren(element, children) {
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (
      child === null ||
      child === undefined ||
      child === false ||
      child === true
    ) {
      continue;
    }
    if (Array.isArray(child)) {
      addChildren(element, child);
    } else if (child instanceof Node) {
      element.appendChild(child);
    } else {
      element.appendChild(document.createTextNode(String(child)));
    }
  }
}

// Build an element.
export function h(tag, props) {
  const isSvg = SVG_TAGS[tag] === true;
  const element = isSvg
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
  element._on = null;
  if (props) {
    Object.keys(props).forEach(function (name) {
      const value = props[name];
      if (name === "key") {
        if (value !== null && value !== undefined) {
          element._key = String(value);
        }
      } else if (name === "ref") {
        element._ref = value;
      } else if (name === "html") {
        element._html =
          value === null || value === undefined ? "" : String(value);
      } else if (
        name.length > 2 &&
        name.indexOf("on") === 0 &&
        typeof value === "function"
      ) {
        const eventName = name.slice(2).toLowerCase();
        if (!element._on) {
          element._on = {};
        }
        element._on[eventName] = value;
        element["on" + eventName] = value;
      } else if (PROPERTY_NAMES[name]) {
        if (!element._props) {
          element._props = {};
        }
        element._props[name] = value;
      } else if (name === "class" || name === "className") {
        if (value) {
          element.setAttribute("class", value);
        }
      } else if (name === "style") {
        if (value) {
          const text = styleText(value);
          if (text) {
            element.setAttribute("style", text);
          }
        }
      } else if (name === "htmlFor") {
        element.setAttribute("for", value);
      } else if (value === true) {
        element.setAttribute(name, "");
      } else if (value !== false && value !== null && value !== undefined) {
        element.setAttribute(name, String(value));
      }
    });
  }
  const children = Array.prototype.slice.call(arguments, 2);
  addChildren(element, children);
  // Properties last: a <select> can only take its value once its options exist.
  if (element._props) {
    Object.keys(element._props).forEach(function (name) {
      element[name] = element._props[name];
    });
  }
  return element;
}

// Mark an element that manages itself (the photo stage, the bottom sheet...). update() puts
// it in the right place but never changes what is inside it.
export function live(element) {
  element._live = true;
  return element;
}

// Write trusted markup (html prop) into new elements just before they join the page.
function prepareNew(node) {
  if (node.nodeType !== 1 || node._live) {
    return;
  }
  if (node._html !== undefined) {
    node.innerHTML = node._html;
    node._htmlApplied = node._html;
  } else {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      prepareNew(child);
    }
  }
  if (node._ref) {
    refQueue.push(node);
  }
}

function syncAttributes(from, to) {
  const toAttributes = to.attributes;
  for (let index = 0; index < toAttributes.length; index += 1) {
    const attribute = toAttributes[index];
    if (from.getAttribute(attribute.name) !== attribute.value) {
      from.setAttribute(attribute.name, attribute.value);
    }
  }
  const fromAttributes = from.attributes;
  for (let index = fromAttributes.length - 1; index >= 0; index -= 1) {
    const name = fromAttributes[index].name;
    // The browser sets "open" on <dialog> and <details> itself; removing it by hand would
    // leave a modal dialog half closed. Dialogs are opened and closed with their methods.
    if (
      name === "open" &&
      (from.nodeName === "DIALOG" || from.nodeName === "DETAILS")
    ) {
      continue;
    }
    // A canvas's width and height are its drawing buffer, owned by the code that paints on it (the
    // stage sizes its overlay to the screen's pixel density). Writing canvas.width puts that
    // attribute on the element, so removing it because the new tree does not list it would reset
    // the buffer to 300 x 150 and blank it on every re-render: on a phone the outlines vanished or
    // were redrawn tiny and stretched over the photo.
    if (
      from.nodeName === "CANVAS" &&
      (name === "width" || name === "height")
    ) {
      continue;
    }
    if (!to.hasAttribute(name)) {
      from.removeAttribute(name);
    }
  }
}

function syncHandlers(from, to) {
  const fromOn = from._on || {};
  const toOn = to._on || {};
  Object.keys(fromOn).forEach(function (name) {
    if (!toOn[name]) {
      from["on" + name] = null;
    }
  });
  Object.keys(toOn).forEach(function (name) {
    if (from["on" + name] !== toOn[name]) {
      from["on" + name] = toOn[name];
    }
  });
  from._on = to._on;
}

function syncProperties(from, to) {
  const props = to._props;
  if (!props) {
    return;
  }
  Object.keys(props).forEach(function (name) {
    const value = props[name];
    if (name === "value") {
      const text = value === null || value === undefined ? "" : String(value);
      if (from.value !== text) {
        from.value = text;
      }
    } else if (from[name] !== value) {
      from[name] = value;
    }
  });
  from._props = props;
}

function sameKind(from, to) {
  return (
    from.nodeType === to.nodeType &&
    from.nodeName === to.nodeName &&
    (from._key || null) === (to._key || null)
  );
}

// Make `from` (live) look like `to` (new). Returns the node that belongs in the page.
function morphNode(from, to) {
  if (from === to) {
    return from;
  }
  if (to._live) {
    return to;
  }
  if (!sameKind(from, to) || from._live) {
    prepareNew(to);
    return to;
  }
  if (from.nodeType === 3 || from.nodeType === 8) {
    if (from.nodeValue !== to.nodeValue) {
      from.nodeValue = to.nodeValue;
    }
    return from;
  }
  syncAttributes(from, to);
  syncHandlers(from, to);
  from._ref = to._ref;
  if (to._html !== undefined) {
    if (from._htmlApplied !== to._html) {
      from.innerHTML = to._html;
      from._htmlApplied = to._html;
    }
    from._html = to._html;
  } else {
    from._html = undefined;
    from._htmlApplied = undefined;
    morphChildren(from, to);
  }
  syncProperties(from, to);
  if (from._ref) {
    refQueue.push(from);
  }
  return from;
}

function morphChildren(fromParent, toParent) {
  const newKids = Array.prototype.slice.call(toParent.childNodes);
  const oldKids = Array.prototype.slice.call(fromParent.childNodes);
  const keyed = new Map();
  const unkeyed = [];
  oldKids.forEach(function (node) {
    if (node._key) {
      keyed.set(node._key, node);
    } else if (!node._live) {
      unkeyed.push(node);
    }
  });
  let unkeyedIndex = 0;
  for (let index = 0; index < newKids.length; index += 1) {
    const wanted = newKids[index];
    let match = null;
    if (wanted._live) {
      match = wanted;
    } else if (wanted._key) {
      match = keyed.get(wanted._key) || null;
      if (match) {
        keyed.delete(wanted._key);
      }
    } else if (unkeyedIndex < unkeyed.length) {
      const candidate = unkeyed[unkeyedIndex];
      if (sameKind(candidate, wanted)) {
        match = candidate;
        unkeyedIndex += 1;
      }
    }
    let result;
    if (match) {
      result = morphNode(match, wanted);
    } else {
      prepareNew(wanted);
      result = wanted;
    }
    const current = fromParent.childNodes[index];
    if (current !== result) {
      fromParent.insertBefore(result, current || null);
    }
  }
  while (fromParent.childNodes.length > newKids.length) {
    fromParent.removeChild(fromParent.lastChild);
  }
}

function flushRefs() {
  const queue = refQueue;
  refQueue = [];
  queue.forEach(function (node) {
    if (typeof node._ref === "function") {
      node._ref(node);
    }
  });
}

// Make the children of `container` match `children` (an element, text, or a list of them).
export function update(container, children) {
  const scratch =
    container.namespaceURI === SVG_NS
      ? document.createElementNS(SVG_NS, "g")
      : document.createElement("div");
  addChildren(scratch, Array.isArray(children) ? children : [children]);
  morphChildren(container, scratch);
  flushRefs();
}

// Join class names, skipping empty ones: cx("sr-tab", active && "is-active").
export function cx() {
  const names = [];
  for (let index = 0; index < arguments.length; index += 1) {
    if (arguments[index]) {
      names.push(arguments[index]);
    }
  }
  return names.join(" ");
}

export function isTyping(target) {
  if (!target) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
