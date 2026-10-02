"use strict";

/**
 * Bit, la mascota de dle_tracker: un bichito de píxeles dibujado en SVG.
 *
 * Uso: <span data-mascot="idle" data-scale="6"></span> y Mascot.mountAll(),
 * o Mascot.setMood(el, "happy"). Estados: idle, happy, sad, spin, sleep.
 */
const Mascot = (() => {
  const BODY = [
    "..#.......#..",
    "...#.....#...",
    "..#########..",
    ".###########.",
    ".###########.",
    ".###########.",
    ".###########.",
    "#############",
    "#.#########.#",
    "..#########..",
    "..##.....##..",
  ];

  // Celdas [fila, columna] que se "recortan" del cuerpo para formar la cara.
  const FACES = {
    idle: [[4, 3], [5, 3], [4, 9], [5, 9], [7, 5], [7, 6], [7, 7]],
    blink: [[5, 3], [5, 9], [7, 5], [7, 6], [7, 7]],
    happy: [[5, 2], [4, 3], [5, 4], [5, 8], [4, 9], [5, 10], [6, 4], [7, 5], [7, 6], [7, 7], [6, 8]],
    sad: [[5, 3], [5, 9], [4, 4], [4, 8], [7, 4], [6, 5], [6, 6], [6, 7], [7, 8]],
    spin: [[4, 4], [5, 4], [4, 10], [5, 10], [7, 6]],
    sleep: [[5, 2], [5, 3], [5, 4], [5, 8], [5, 9], [5, 10], [7, 6]],
  };

  const W = BODY[0].length;
  const H = BODY.length;

  function svg(mood, scale) {
    const cut = new Set((FACES[mood] || FACES.idle).map(([r, c]) => `${r},${c}`));
    const rects = [];
    BODY.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch === "#" && !cut.has(`${r},${c}`)) rects.push(`<rect x="${c}" y="${r}" width="1.02" height="1.02"/>`);
      });
    });
    return `<svg class="mascot-svg" viewBox="0 0 ${W} ${H}" width="${W * scale}" height="${H * scale}" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true">${rects.join("")}</svg>`;
  }

  function setMood(el, mood) {
    if (!el) return;
    el.dataset.mascot = mood;
    el.innerHTML = svg(mood, Number(el.dataset.scale) || 6);
    el.classList.add("mascot");
    el.classList.toggle("mascot-happy", mood === "happy");
    el.classList.toggle("mascot-spin", mood === "spin");
  }

  function mountAll(root = document) {
    root.querySelectorAll("[data-mascot]").forEach((el) => setMood(el, el.dataset.mascot || "idle"));
  }

  // Parpadeo ocasional de las mascotas en reposo.
  setInterval(() => {
    document.querySelectorAll('[data-mascot="idle"]').forEach((el) => {
      if (Math.random() < 0.5) return;
      el.innerHTML = svg("blink", Number(el.dataset.scale) || 6);
      setTimeout(() => { if (el.dataset.mascot === "idle") setMood(el, "idle"); }, 160);
    });
  }, 3200);

  return { setMood, mountAll, svg };
})();
