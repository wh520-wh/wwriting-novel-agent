export const ICON_PATHS = {
  compose: "M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6 M18.4 3.6a1.7 1.7 0 0 1 2.4 2.4L12.5 16.3l-3.4.9.9-3.4z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20.5 20.5 16 16",
  skill: "M12 3l7.5 4.3v8.6L12 20.2 4.5 15.9V7.3z M12 8.2v3.6 M12 11.8 9 13.5 M12 11.8 15 13.5",
  check: "M5 12.5l4.2 4.2L19 7",
  help: "M9 9a3 3 0 1 1 4 2.8c-.9.5-1.5 1-1.5 2.2M12 17.5h.01 M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  folder: "M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  book: "M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 17.5h13",
  coin: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M9.5 8.5l2.5 3 2.5-3 M12 11.5v5 M10 13.5h4",
  settings: "M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h7M15 17.5h5",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4",
  chevR: "M9 6l6 6-6 6",
  arrowUp: "M12 19V5 M5 12l7-7 7 7",
  bolt: "M13 3 4 14h6l-1 7 9-11h-6z",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  eyeOff: "M3.5 4l17 16 M2.5 12s3.5-6.5 9.5-6.5c1.9 0 3.6.6 5 1.5 M9 6.2C10 5.8 11 5.5 12 5.5c6 0 9.5 6.5 9.5 6.5s-1.4 2.6-3.9 4.6 M14.5 14.6A2.8 2.8 0 0 1 9.5 9.5",
  copy: "M9 9h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z M6 15H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  trash: "M5 7h14 M9 7V4h6v3 M8 10v7 M12 10v7 M16 10v7 M7 7l1 14h8l1-14",
  plus: "M12 5v14M5 12h14"
};

export function icon(name, size = 16, cls, doc = globalThis.document) {
  const ns = "http://www.w3.org/2000/svg";
  if (typeof doc?.createElementNS !== "function") throw new TypeError("icon() requires a document with createElementNS().");
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (cls) svg.setAttribute("class", cls);
  for (const seg of (ICON_PATHS[name] ?? "").split(" M")) {
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", seg.startsWith("M") ? seg : `M${seg}`.replace(/^MM/, "M"));
    svg.append(path);
  }
  return svg;
}
