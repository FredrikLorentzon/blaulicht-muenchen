'use strict';

/*
 * Drag a patient figure from the map dock onto Munich to report an emergency.
 * The figure hangs from the pointer and swings with a damped spring driven by
 * the horizontal drag speed. It drops where its shadow is.
 */
window.BL = window.BL || {};

(function (BL) {
  const DROP_OFFSET_Y = 50;
  const SWING_GAIN = 0.045;
  const SWING_MAX_DEG = 55;
  const SPRING_STIFFNESS = 90;
  const SPRING_DAMPING = 9;
  const DRAG_THRESHOLD_PX = 3;

  const FIGURE_SVG = `
    <svg class="pd-figure" viewBox="0 0 32 48" width="32" height="48" aria-hidden="true">
      <g class="pd-arm pd-arm-l"><path d="M11 17 L4 9" /></g>
      <g class="pd-arm pd-arm-r"><path d="M21 17 L28 9" /></g>
      <g class="pd-leg pd-leg-l"><path d="M13 31 L12 43" /></g>
      <g class="pd-leg pd-leg-r"><path d="M19 31 L20 43" /></g>
      <rect class="pd-body" x="9" y="15" width="14" height="18" rx="6" />
      <path class="pd-cross" d="M16 19.5v8M12 23.5h8" />
      <circle class="pd-head" cx="16" cy="8.5" r="6.5" />
      <circle class="pd-eye" cx="13.8" cy="8" r="1" />
      <circle class="pd-eye" cx="18.2" cy="8" r="1" />
      <path class="pd-mouth" d="M13.5 11.2 Q16 13.2 18.5 11.2" />
    </svg>`;

  function createElement(tag, className, html) {
    const node = document.createElement(tag);
    node.className = className;
    if (html) node.innerHTML = html;
    return node;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function createPatientDrag({ stage, sim, map }) {
    const dock = createElement('button', 'pd-dock', FIGURE_SVG);
    dock.type = 'button';
    dock.title = 'Drag onto the map to report an emergency';
    dock.setAttribute('aria-label', 'Drag a patient onto the map to report an emergency');
    stage.appendChild(dock);

    const ghost = createElement('div', 'pd-ghost', FIGURE_SVG);
    const shadow = createElement('div', 'pd-shadow');
    ghost.hidden = true;
    shadow.hidden = true;
    document.body.append(shadow, ghost);

    const drag = { active: false, started: false, pointerId: null, x: 0, y: 0, lastX: 0, lastT: 0, vx: 0, angle: 0, spin: 0, frame: 0, startX: 0, startY: 0 };

    function mapRect() {
      return stage.querySelector('svg').getBoundingClientRect();
    }

    function dropPoint() {
      return { x: drag.x, y: drag.y + DROP_OFFSET_Y };
    }

    function isOverMap(point) {
      const r = mapRect();
      return point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
    }

    function placeGhost() {
      ghost.style.transform = `translate(${drag.x}px, ${drag.y}px) rotate(${drag.angle.toFixed(2)}deg)`;
      const point = dropPoint();
      const over = isOverMap(point);
      shadow.hidden = !over;
      shadow.style.transform = `translate(${point.x}px, ${point.y}px)`;
      ghost.classList.toggle('is-over-map', over);
    }

    function animate(now) {
      if (!drag.active) return;
      const dt = Math.min(0.05, (now - drag.lastT) / 1000 || 0.016);
      drag.lastT = now;
      const instantVx = (drag.x - drag.lastX) / Math.max(dt, 0.001);
      drag.lastX = drag.x;
      drag.vx += (instantVx - drag.vx) * Math.min(1, dt * 12);
      const target = clamp(drag.vx * SWING_GAIN, -SWING_MAX_DEG, SWING_MAX_DEG);
      drag.spin += ((target - drag.angle) * SPRING_STIFFNESS - drag.spin * SPRING_DAMPING) * dt;
      drag.angle += drag.spin * dt;
      placeGhost();
      drag.frame = requestAnimationFrame(animate);
    }

    function beginDrag() {
      drag.started = true;
      drag.lastX = drag.x;
      drag.lastT = performance.now();
      drag.vx = 0;
      drag.angle = 0;
      drag.spin = 0;
      ghost.hidden = false;
      ghost.classList.remove('is-landing', 'is-returning');
      ghost.classList.add('is-dragging');
      dock.classList.add('is-empty');
      document.body.classList.add('pd-grabbing');
      placeGhost();
      drag.frame = requestAnimationFrame(animate);
    }

    function finishGhost(className, transform) {
      ghost.classList.remove('is-dragging');
      ghost.classList.add(className);
      ghost.style.transform = transform;
      shadow.hidden = true;
      window.setTimeout(() => {
        ghost.hidden = true;
        ghost.classList.remove(className);
        dock.classList.remove('is-empty');
      }, 380);
    }

    function landAt(point) {
      const [x, y] = map.clientToMap(point.x, point.y);
      sim.spawnCall({ x, y });
      finishGhost('is-landing', `translate(${point.x}px, ${point.y - 40}px)`);
    }

    function returnToDock() {
      const r = dock.getBoundingClientRect();
      finishGhost('is-returning', `translate(${r.left + r.width / 2}px, ${r.top + 6}px)`);
    }

    function endDrag(cancelled) {
      if (!drag.active) return;
      drag.active = false;
      cancelAnimationFrame(drag.frame);
      document.body.classList.remove('pd-grabbing');
      if (drag.pointerId !== null && dock.hasPointerCapture(drag.pointerId)) dock.releasePointerCapture(drag.pointerId);
      if (!drag.started) return;
      const point = dropPoint();
      if (!cancelled && isOverMap(point)) landAt(point);
      else returnToDock();
    }

    function onPointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.active = true;
      drag.started = false;
      drag.pointerId = event.pointerId;
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      dock.setPointerCapture(event.pointerId);
    }

    function onPointerMove(event) {
      if (!drag.active) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      const moved = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
      if (!drag.started && moved > DRAG_THRESHOLD_PX) beginDrag();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && drag.active) {
        event.stopPropagation();
        endDrag(true);
      }
    }

    dock.addEventListener('pointerdown', onPointerDown);
    dock.addEventListener('pointermove', onPointerMove);
    dock.addEventListener('pointerup', () => endDrag(false));
    dock.addEventListener('pointercancel', () => endDrag(true));
    window.addEventListener('keydown', onKeyDown, true);

    return { dock };
  }

  BL.createPatientDrag = createPatientDrag;
})(window.BL);
