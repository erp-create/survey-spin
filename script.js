/* =============================================================================
   THE WHEEL TASK — APPLICATION LOGIC
   Vanilla JS, no dependencies. Organized into clearly separated concerns:
     1. CONFIG            – every tunable constant lives here
     2. STATE             – single mutable state object for the whole session
     3. WHEEL RENDERING    – builds and spins the SVG wheel
     4. SCORING            – pure functions for score/penalty math
     5. DATA COLLECTION    – builds the per-spin log entries
     6. SOUND              – tiny Web Audio beep helper (optional, removable)
     7. SCREEN / UI CONTROL – swapping screens, rendering readouts
     8. EXPORT              – JSON / CSV download
     9. EVENT WIRING        – DOMContentLoaded bootstrap
   ========================================================================== */

(function () {
  "use strict";

  /* ----------------------------- 1. CONFIG -------------------------------- *
   * Change any of these to retune the experiment without touching logic.    */
  const CONFIG = {
    initialScore: 40,          // starting score
    greenReward: 10,           // points added on a win (every time, flat)
    penaltySequence: [2, 4, 8, 16, 32], // loss penalty, in order — doubles each time, never resets
    numSegments: 10,           // must be even — alternates red/green, 50/50 area
    maxSpins: 5,                // hard cap — the spin button disables once this many spins are used
    wheelColors: {
      green: { fill: "#2f8f5b", strokeDark: "#1f6640" },
      red: { fill: "#c6473f", strokeDark: "#8f2f29" }
    },
    spinDurationMs: 4200,       // base animation duration
    minFullSpinTurns: 6,        // extra full rotations added per spin, for visual effect
    maxFullSpinTurns: 9,
    soundEnabled: true,         // master switch — set false, or delete the playTone() calls, to remove audio entirely

    // Paste the URL you get after deploying the included Apps Script as a Web
    // App (see SHEET_SETUP.md). Leave blank to disable auto-submission —
    // the app still works fully offline via the local JSON/CSV export.
    sheetWebhookUrl: "https://script.google.com/macros/s/AKfycbzqbUIavLahLaTd01vmjFI8zVMzrl9qa0CTb02pTAdkZHxSlhxyzp3VilvxceX-SewFDg/exec"
  };

  /* ----------------------------- 2. STATE ---------------------------------- */
  let state = null; // (re)initialized by resetState()

  function resetState() {
    state = {
      spinCount: 0,
      greenCount: 0,
      redCount: 0,
      nextRedPenalty: CONFIG.penaltySequence[0], // penalty that WOULD apply if the next spin is red
      maxPenaltyReached: 0,
      totalGained: 0,            // sum of every green reward so far
      totalLost: 0,              // sum of every red penalty so far
      checkpointShown: false,    // the 3rd-loss checkpoint only ever fires once per session
      studentName: "",
      studentClass: "",
      studentSection: "",
      hasSubmitted: false,       // guards against ever posting the same session twice
      history: [],              // array of spin log entries, see logSpin()
      experimentStartTime: null,
      readyTimestamp: null,     // timestamp from which the next reaction time is measured
      isSpinning: false,
      currentTotalRotation: 0,  // accumulated rotation in degrees, never reset mid-session
      soundOn: CONFIG.soundEnabled
    };
  }

  /* ------------------------- 3. WHEEL RENDERING ----------------------------- *
   * The wheel is built once as an SVG group of pie-slice <path> elements,
   * alternating red/green. Spinning is a CSS transform on that group; the
   * math below picks a target rotation that lands the pointer inside a
   * segment of the pre-determined outcome color.                             */

  const WHEEL_CENTER = 200;
  const WHEEL_RADIUS = 188;
  const WHEEL_HUB_RADIUS = 34;
  const SEGMENT_ANGLE = 360 / CONFIG.numSegments;

  // Convert an angle measured CLOCKWISE from the top (12 o'clock = 0deg)
  // into SVG (x, y) coordinates.
  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: cx + r * Math.sin(rad),
      y: cy - r * Math.cos(rad)
    };
  }

  // Build an SVG path "d" string for a pie slice spanning [startAngle, endAngle).
  function describeSlicePath(cx, cy, r, startAngle, endAngle) {
    const p0 = polarToCartesian(cx, cy, r, startAngle);
    const p1 = polarToCartesian(cx, cy, r, endAngle);
    const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
    return [
      `M ${cx} ${cy}`,
      `L ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}`,
      `A ${r} ${r} 0 ${largeArcFlag} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
      "Z"
    ].join(" ");
  }

  // Returns "green" or "red" for a given segment index (alternating).
  function colorForSegmentIndex(index) {
    return index % 2 === 0 ? "green" : "red";
  }

  // Builds the static wheel: colored slices, boundary ticks, rim, and hub.
  function buildWheelSvg() {
    const svgNS = "http://www.w3.org/2000/svg";
    const group = document.getElementById("wheelGroup");
    group.innerHTML = "";

    for (let i = 0; i < CONFIG.numSegments; i++) {
      const startAngle = i * SEGMENT_ANGLE;
      const endAngle = startAngle + SEGMENT_ANGLE;
      const color = colorForSegmentIndex(i);
      const palette = CONFIG.wheelColors[color];

      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", describeSlicePath(WHEEL_CENTER, WHEEL_CENTER, WHEEL_RADIUS, startAngle, endAngle));
      path.setAttribute("fill", palette.fill);
      path.setAttribute("stroke", "#f5f3ee");
      path.setAttribute("stroke-width", "2");
      group.appendChild(path);
    }

    // Outer rim, styled like an instrument dial.
    const rim = document.createElementNS(svgNS, "circle");
    rim.setAttribute("cx", WHEEL_CENTER);
    rim.setAttribute("cy", WHEEL_CENTER);
    rim.setAttribute("r", WHEEL_RADIUS);
    rim.setAttribute("fill", "none");
    rim.setAttribute("stroke", "#171b1e");
    rim.setAttribute("stroke-width", "3");
    rim.setAttribute("opacity", "0.15");
    group.appendChild(rim);

    // Minor tick marks just inside the rim, evenly spaced, for the dial look.
    const tickCount = CONFIG.numSegments * 3;
    for (let t = 0; t < tickCount; t++) {
      const angle = (360 / tickCount) * t;
      const outer = polarToCartesian(WHEEL_CENTER, WHEEL_CENTER, WHEEL_RADIUS - 3, angle);
      const inner = polarToCartesian(WHEEL_CENTER, WHEEL_CENTER, WHEEL_RADIUS - 12, angle);
      const tick = document.createElementNS(svgNS, "line");
      tick.setAttribute("x1", outer.x.toFixed(2));
      tick.setAttribute("y1", outer.y.toFixed(2));
      tick.setAttribute("x2", inner.x.toFixed(2));
      tick.setAttribute("y2", inner.y.toFixed(2));
      tick.setAttribute("stroke", "#f5f3ee");
      tick.setAttribute("stroke-width", "1.5");
      tick.setAttribute("opacity", "0.55");
      group.appendChild(tick);
    }

    // Center hub.
    const hub = document.createElementNS(svgNS, "circle");
    hub.setAttribute("cx", WHEEL_CENTER);
    hub.setAttribute("cy", WHEEL_CENTER);
    hub.setAttribute("r", WHEEL_HUB_RADIUS);
    hub.setAttribute("fill", "#171b1e");
    hub.setAttribute("stroke", "#f5f3ee");
    hub.setAttribute("stroke-width", "3");
    group.appendChild(hub);

    const hubRing = document.createElementNS(svgNS, "circle");
    hubRing.setAttribute("cx", WHEEL_CENTER);
    hubRing.setAttribute("cy", WHEEL_CENTER);
    hubRing.setAttribute("r", WHEEL_HUB_RADIUS - 9);
    hubRing.setAttribute("fill", "none");
    hubRing.setAttribute("stroke", "#f5f3ee");
    hubRing.setAttribute("stroke-width", "1.5");
    hubRing.setAttribute("opacity", "0.5");
    group.appendChild(hubRing);
  }

  // Picks a random outcome with exactly 50/50 probability.
  function determineOutcome() {
    return Math.random() < 0.5 ? "green" : "red";
  }

  // Given a desired outcome color, choose a landing angle (0-360, clockwise
  // from top) that falls inside a random segment of that color, with a small
  // inward jitter so it doesn't always land dead-center.
  function pickLandingAngleForOutcome(outcome) {
    const matchingIndices = [];
    for (let i = 0; i < CONFIG.numSegments; i++) {
      if (colorForSegmentIndex(i) === outcome) matchingIndices.push(i);
    }
    const chosenIndex = matchingIndices[Math.floor(Math.random() * matchingIndices.length)];
    const segStart = chosenIndex * SEGMENT_ANGLE;
    const margin = SEGMENT_ANGLE * 0.22; // keep away from the boundary lines
    const jitter = margin + Math.random() * (SEGMENT_ANGLE - margin * 2);
    return segStart + jitter;
  }

  // Animates the wheel to land the pointer (fixed at top) on a segment of
  // the given outcome color. Returns a Promise that resolves when the CSS
  // transition finishes.
  function spinWheelToOutcome(outcome) {
    const group = document.getElementById("wheelGroup");
    const landingAngle = pickLandingAngleForOutcome(outcome);

    // We need (currentTotalRotation + R) mod 360 == 0 at the chosen angle's
    // position, i.e. the landing angle should sit at the top after rotating.
    // R (mod 360) must equal (360 - landingAngle) mod 360.
    const desiredMod = (360 - landingAngle + 360) % 360;
    const currentMod = ((state.currentTotalRotation % 360) + 360) % 360;
    const deltaToAdd = (desiredMod - currentMod + 360) % 360;

    const fullTurns = CONFIG.minFullSpinTurns +
      Math.floor(Math.random() * (CONFIG.maxFullSpinTurns - CONFIG.minFullSpinTurns + 1));

    const newTotalRotation = state.currentTotalRotation + fullTurns * 360 + deltaToAdd;

    // Slight randomized duration keeps repeated spins from feeling mechanical.
    const duration = CONFIG.spinDurationMs + Math.floor(Math.random() * 400 - 200);

    return new Promise((resolve) => {
      group.style.transition = `transform ${duration}ms cubic-bezier(0.15, 0.65, 0.1, 1)`;
      // Force reflow so the transition reliably applies before we change transform.
      // eslint-disable-next-line no-unused-expressions
      group.getBoundingClientRect();
      group.style.transform = `rotate(${newTotalRotation}deg)`;

      const onEnd = (event) => {
        if (event.target !== group || event.propertyName !== "transform") return;
        group.removeEventListener("transitionend", onEnd);
        resolve();
      };
      group.addEventListener("transitionend", onEnd);

      // Fallback in case transitionend doesn't fire (e.g. tab backgrounded).
      setTimeout(resolve, duration + 300);
    }).then(() => {
      state.currentTotalRotation = newTotalRotation;
    });
  }

  /* ------------------------------- 4. SCORING -------------------------------- */

  // Applies a single spin outcome and returns the log entry data needed by
  // logSpin(). IMPORTANT: this app measures DECISIONS (spin vs. stop), not
  // accumulated score — so every spin conceptually starts fresh at
  // CONFIG.initialScore rather than carrying a running total from the last
  // spin. The escalating loss penalty is untouched by this: it still climbs
  // with every red outcome (state.redCount), exactly as before — only the
  // "starting point" for each round's own before/after no longer persists.
  function applyOutcomeToScore(outcome) {
    const scoreBefore = CONFIG.initialScore;
    let scoreAfter;
    let penaltyApplied = 0;

    if (outcome === "green") {
      scoreAfter = scoreBefore + CONFIG.greenReward;
      state.greenCount += 1;
      state.totalGained += CONFIG.greenReward;
      // Loss penalty is untouched by wins, per spec.
    } else {
      penaltyApplied = CONFIG.penaltySequence[state.redCount] ??
        CONFIG.penaltySequence[CONFIG.penaltySequence.length - 1];
      scoreAfter = scoreBefore - penaltyApplied;
      state.redCount += 1;
      state.totalLost += penaltyApplied;
      state.maxPenaltyReached = Math.max(state.maxPenaltyReached, penaltyApplied);
      // Next penalty is simply the next value in the sequence (doubles each time).
      state.nextRedPenalty = CONFIG.penaltySequence[state.redCount] ??
        CONFIG.penaltySequence[CONFIG.penaltySequence.length - 1];
    }

    return { scoreBefore, scoreAfter, penaltyApplied };
  }

  /* --------------------------- 5. DATA COLLECTION ---------------------------- */

  function logSpin(outcome, scoreBefore, scoreAfter, penaltyApplied, reactionTimeMs) {
    const now = Date.now();
    const pointsDelta = outcome === "green" ? CONFIG.greenReward : -penaltyApplied;
    const entry = {
      timestamp: new Date(now).toISOString(),
      spinNumber: state.spinCount,
      wheelResult: outcome,
      scoreBefore: scoreBefore,
      scoreAfter: scoreAfter,
      pointsDelta: pointsDelta,
      lossPenaltyApplied: penaltyApplied,
      reactionTimeMs: reactionTimeMs,
      totalElapsedMs: now - state.experimentStartTime
    };
    state.history.push(entry);
    return entry;
  }

  /* --------------------------------- 6. SOUND --------------------------------- *
   * Synthesized tones via the Web Audio API — no audio files required.
   * To remove sound entirely: delete this block and the calls to playTone(). */

  let audioContext = null;
  function getAudioContext() {
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      audioContext = new AudioCtx();
    }
    return audioContext;
  }

  function playTone(frequency, durationMs, type) {
    if (!state.soundOn) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = type || "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + durationMs / 1000);
    } catch (err) {
      // Audio is a non-essential enhancement — fail silently.
    }
  }

  function playSpinStartSound() { playTone(320, 140, "triangle"); }
  function playGreenSound() { playTone(660, 260, "sine"); setTimeout(() => playTone(880, 220, "sine"), 120); }
  function playRedSound() { playTone(180, 320, "sawtooth"); }

  /* ---------------------------- 7. SCREEN / UI CONTROL -------------------------- */

  // Toggles whether the wheel is visible. Hidden = at rest, waiting on a
  // decision (start of session, between spins). Visible = actively spinning
  // / showing a just-landed result, so the segment layout can't be studied
  // ahead of a decision.
  function setWheelVisible(visible) {
    if (!els.wheelStage) return;
    els.wheelStage.classList.toggle("is-hidden", !visible);
    if (visible) {
      els.wheelStage.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function triggerShake(el) {
    el.classList.remove("is-shaking");
    // eslint-disable-next-line no-unused-expressions
    void el.offsetWidth;
    el.classList.add("is-shaking");
  }

  function triggerSweep(el) {
    if (!el) return;
    el.classList.remove("is-sweeping");
    // eslint-disable-next-line no-unused-expressions
    void el.offsetWidth; // force reflow so the animation can restart cleanly every time
    el.classList.add("is-sweeping");
  }

  const els = {}; // populated in cacheElements()

  function cacheElements() {
    els.welcomeScreen = document.getElementById("welcomeScreen");
    els.experimentScreen = document.getElementById("experimentScreen");
    els.resultsScreen = document.getElementById("resultsScreen");

    els.studentNameInput = document.getElementById("studentNameInput");
    els.studentClassSelect = document.getElementById("studentClassSelect");
    els.studentSectionSelect = document.getElementById("studentSectionSelect");
    els.identityCard = document.getElementById("identityCard");
    els.beginButton = document.getElementById("beginButton");
    els.submitStatus = document.getElementById("submitStatus");

    els.spinButton = document.getElementById("spinButton");
    els.stopButton = document.getElementById("stopButton");
    els.progressFill = document.getElementById("progressFill");
    els.progressTrack = document.getElementById("progressTrack");
    els.gameTitle = document.getElementById("gameTitle");
    els.gameMp = document.getElementById("gameMp");
    els.wheelStage = document.getElementById("wheelStage");
    els.nextRoundCard = document.getElementById("nextRoundCard");
    els.nextLossValue = document.getElementById("nextLossValue");
    els.nextLossEquation = document.getElementById("nextLossEquation");
    els.decisionQuestion = document.getElementById("decisionQuestion");

    els.summaryGrid = document.getElementById("summaryGrid");
    els.resultsIdentity = document.getElementById("resultsIdentity");
    els.debriefBox = document.getElementById("debriefBox");
    els.historyTableBody = document.getElementById("historyTableBody");
    els.restartButton = document.getElementById("restartButton");
    els.resultsSubmitStatus = document.getElementById("resultsSubmitStatus");

    els.checkpointModal = document.getElementById("checkpointModal");
    els.checkpointStats = document.getElementById("checkpointStats");
    els.checkpointContinueButton = document.getElementById("checkpointContinueButton");
    els.checkpointStopButton = document.getElementById("checkpointStopButton");

    els.confirmModal = document.getElementById("confirmModal");
    els.confirmStopButton = document.getElementById("confirmStopButton");
    els.cancelStopButton = document.getElementById("cancelStopButton");

    els.themeToggle = document.getElementById("themeToggle");
    els.soundToggle = document.getElementById("soundToggle");
  }

  function showScreen(screenEl) {
    [els.welcomeScreen, els.experimentScreen, els.resultsScreen].forEach((s) => {
      s.classList.remove("is-active");
    });
    screenEl.classList.add("is-active");
    screenEl.scrollIntoView({ behavior: "smooth", block: "start" });
    const heading = screenEl.querySelector("h1");
    if (heading) heading.setAttribute("tabindex", "-1");
    if (heading) heading.focus({ preventScroll: true });
  }

  // Refreshes every number on the experiment screen from current state.
  function renderExperimentReadouts() {
    renderGameHeading();
    updateProgressUI();
  }

  // "Game N" always reflects the round the student is about to play (or just
  // played); MP is the fixed points every round starts from — it never
  // changes, since nothing carries over between spins.
  function renderGameHeading() {
    if (!els.gameTitle) return;
    const gameNumber = Math.min(state.spinCount + 1, CONFIG.maxSpins);
    els.gameTitle.textContent = `Game ${gameNumber}`;
    els.gameMp.textContent = `MP : ${CONFIG.initialScore}`;
  }

  // Updates the progress bar against the hard maxSpins cap, keeps the spin
  // button in sync once that cap is reached, and refreshes the instruction
  // card to match.
  function updateProgressUI() {
    const progressPct = Math.min(100, Math.round((state.spinCount / CONFIG.maxSpins) * 100));
    els.progressFill.style.width = progressPct + "%";
    els.progressTrack.setAttribute("aria-valuenow", String(progressPct));

    if (state.spinCount >= CONFIG.maxSpins) {
      els.spinButton.textContent = "All 5 spins used";
      els.spinButton.disabled = true;
    }

    renderNextRoundPreview();
  }

  // The instruction card that replaces the old compact "If green / If red /
  // Spins taken" readout bar — same numbers, spelled out plainly, with the
  // dynamic value shown big AND spelled out as a full MP calculation
  // (40 + 10 = 50 / 40 − N = ...) so the arithmetic is never left implicit.
  function renderNextRoundPreview() {
    if (!els.nextRoundCard) return;
    if (state.spinCount >= CONFIG.maxSpins) {
      els.nextRoundCard.innerHTML = `
        <p class="instruction-line">No spins left &mdash; results coming up.</p>
      `;
    } else {
      const mp = CONFIG.initialScore;
      const winTotal = mp + CONFIG.greenReward;
      const lossTotal = mp - state.nextRedPenalty;
      els.nextRoundCard.innerHTML = `
        <div class="instruction-col instruction-col-green">
          <svg class="sweep-svg" aria-hidden="true"><rect class="sweep-rect" x="1" y="1" width="99%" height="99%" rx="17" ry="17" pathLength="100"></rect></svg>
          <p class="instruction-line">
            <span class="dot dot-green" aria-hidden="true"></span>
            If the wheel lands on <strong>green</strong>, you win <span class="pts-gain">+${CONFIG.greenReward}</span>
          </p>
          <p class="instruction-value pts-gain">${mp} + ${CONFIG.greenReward} = ${winTotal}</p>
        </div>
        <div class="instruction-col instruction-col-red">
          <svg class="sweep-svg" aria-hidden="true"><rect class="sweep-rect" x="1" y="1" width="99%" height="99%" rx="17" ry="17" pathLength="100"></rect></svg>
          <p class="instruction-line">
            <span class="dot dot-red" aria-hidden="true"></span>
            If the wheel lands on <strong>red</strong>, you lose <span class="pts-loss" id="nextLossValue">\u2212${state.nextRedPenalty}</span>
          </p>
          <p class="instruction-value pts-loss" id="nextLossEquation">${mp} \u2212 ${state.nextRedPenalty} = ${lossTotal}</p>
        </div>
      `;
      els.nextLossValue = document.getElementById("nextLossValue");
      els.nextLossEquation = document.getElementById("nextLossEquation");
    }
  }

  /* -------------------------------- Spin handler -------------------------------- */

  async function handleSpinClick() {
    if (state.isSpinning || state.spinCount >= CONFIG.maxSpins) return;

    const reactionTimeMs = Date.now() - state.readyTimestamp;

    state.isSpinning = true;
    els.spinButton.disabled = true;
    setWheelVisible(true); // reveal the wheel the instant a spin is committed to
    playSpinStartSound();

    const outcome = determineOutcome();
    state.spinCount += 1;

    await spinWheelToOutcome(outcome);

    const { scoreBefore, scoreAfter, penaltyApplied } = applyOutcomeToScore(outcome);
    const entry = logSpin(outcome, scoreBefore, scoreAfter, penaltyApplied, reactionTimeMs);

    renderGameHeading();
    updateProgressUI(); // also refreshes the instruction card (rebuilds its DOM)

    // Sweep only the box matching what actually happened — a quick trace
    // around its border, fired fresh every spin. Guarded because the card
    // has no color boxes left to target once "No spins left" replaces it.
    const sweepTarget = els.nextRoundCard.querySelector(
      outcome === "green" ? ".instruction-col-green" : ".instruction-col-red"
    );
    triggerSweep(sweepTarget);

    if (outcome === "green") {
      playGreenSound();
    } else {
      triggerShake(els.wheelStage);
      playRedSound();
    }

    // Let the student see the landed result clearly for a moment, then the
    // wheel hides again while they decide on the next spin.
    setTimeout(() => setWheelVisible(false), 1100);

    state.readyTimestamp = Date.now();
    state.isSpinning = false;

    const reachedMaxSpins = state.spinCount >= CONFIG.maxSpins;
    const triggerCheckpoint = outcome === "red" && state.redCount === 3 &&
      !state.checkpointShown && !reachedMaxSpins;

    if (triggerCheckpoint) {
      // Spin button stays disabled until the student answers the checkpoint.
      state.checkpointShown = true;
      setTimeout(openCheckpointModal, 500); // brief pause so the shake/result is seen first
    } else if (reachedMaxSpins) {
      // updateProgressUI() already disabled + relabeled the button, and the
      // next-round card already reads "No spins left — results coming up.",
      // so no separate announcement is needed here.
      setTimeout(() => {
        if (!els.resultsScreen.classList.contains("is-active")) endExperiment();
      }, 1800);
    } else {
      els.spinButton.disabled = false;
    }
  }

  /* ------------------------------ Stop / confirm flow ---------------------------- */

  function openConfirmModal() {
    els.confirmModal.hidden = false;
    els.confirmStopButton.focus();
    document.addEventListener("keydown", handleModalKeydown);
  }

  function closeConfirmModal() {
    els.confirmModal.hidden = true;
    document.removeEventListener("keydown", handleModalKeydown);
    els.stopButton.focus();
  }

  function handleModalKeydown(event) {
    if (event.key === "Escape") closeConfirmModal();
  }

  function handleConfirmStop() {
    closeConfirmModal();
    endExperiment();
  }

  /* --------------------------- 3rd-loss checkpoint flow --------------------------- *
   * Fires exactly once, right after the 3rd red outcome (as long as spins
   * remain). Shows a running profit/loss recap and lets the student choose
   * whether to keep spinning or stop early. */

  // Lists every round played so far (win/loss, no running total) plus a
  // preview of what the next spin is worth — the checkpoint is about what
  // happened round-by-round, not a profit/loss recap.
  function renderCheckpointStats() {
    const roundRows = state.history.map((entry) => {
      const isWin = entry.wheelResult === "green";
      const valueText = isWin ? `+${entry.pointsDelta}` : `\u2212${Math.abs(entry.pointsDelta)}`;
      return `
        <div class="checkpoint-round">
          <span class="checkpoint-round-label">Round ${entry.spinNumber} &middot; ${isWin ? "Green" : "Red"}</span>
          <span class="checkpoint-round-value ${isWin ? "gain" : "loss"}">${valueText}</span>
        </div>
      `;
    }).join("");

    const nextRow = `
      <div class="checkpoint-round checkpoint-round-next">
        <span class="checkpoint-round-label">Next spin</span>
        <span class="checkpoint-round-value">
          Win <span class="pts-gain">+${CONFIG.greenReward}</span> &middot;
          Loss <span class="pts-loss">\u2212${state.nextRedPenalty}</span>
        </span>
      </div>
    `;

    els.checkpointStats.innerHTML = roundRows + nextRow;
  }

  function openCheckpointModal() {
    renderCheckpointStats();
    els.checkpointModal.hidden = false;
    els.checkpointContinueButton.focus();
    document.addEventListener("keydown", handleCheckpointKeydown);
  }

  function closeCheckpointModal() {
    els.checkpointModal.hidden = true;
    document.removeEventListener("keydown", handleCheckpointKeydown);
  }

  // Escape mirrors the "safe" choice, same as the stop-confirm modal: it
  // cancels the potentially session-ending action rather than triggering it.
  function handleCheckpointKeydown(event) {
    if (event.key === "Escape") handleCheckpointContinue();
  }

  function handleCheckpointContinue() {
    closeCheckpointModal();
    els.spinButton.disabled = false;
    els.spinButton.focus();
  }

  function handleCheckpointStop() {
    closeCheckpointModal();
    endExperiment();
  }

  /* ---------------------------------- Ending / results ---------------------------- */

  function endExperiment() {
    const totalDurationMs = Date.now() - state.experimentStartTime;
    renderResultsScreen(totalDurationMs);
    showScreen(els.resultsScreen);
    submitSessionToTeacherSheet(els.resultsSubmitStatus);
  }

  function formatDuration(ms) {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  // Builds a plain-language "what just happened" recap tying the numbers
  // back to the loss aversion concept. Deliberately says nothing about a
  // net or final score — the focus is on the decisions made (spin again vs.
  // stop) as the loss penalty climbed, not on how the points added up.
  function buildDebriefHtml() {
    const stoppedEarly = state.spinCount < CONFIG.maxSpins;

    const comparisonSentence = `Across the session you won <strong>${state.greenCount}</strong>
      round${state.greenCount === 1 ? "" : "s"} and lost <strong>${state.redCount}</strong>
      round${state.redCount === 1 ? "" : "s"} &mdash; with the loss penalty climbing to
      \u2212${state.maxPenaltyReached} by the end.`;

    const stopSentence = stoppedEarly
      ? `You chose to stop after ${state.spinCount} of your ${CONFIG.maxSpins} possible spins.`
      : `You used all ${CONFIG.maxSpins} of your spins.`;

    const checkpointSentence = state.checkpointShown
      ? " You also saw the checkpoint after your 3rd loss, with every round up to that point listed out for you."
      : "";

    return `
      <h2>What this shows</h2>
      <p>${comparisonSentence} ${stopSentence}${checkpointSentence}</p>
    `;
  }

  function renderResultsScreen(totalDurationMs) {
    els.resultsIdentity.textContent = `${state.studentName} \u00b7 Class ${state.studentClass}-${state.studentSection}`;

    const summaryItems = [
      { label: "Total spins", value: state.spinCount, accent: "" },
      { label: "Green", value: state.greenCount, accent: "green" },
      { label: "Red", value: state.redCount, accent: "red" },
      { label: "Max loss penalty", value: `\u2212${state.maxPenaltyReached}`, accent: "gold" },
      { label: "Session duration", value: formatDuration(totalDurationMs), accent: "" }
    ];

    els.summaryGrid.innerHTML = summaryItems.map((item) => `
      <div class="summary-card${item.accent ? " accent-" + item.accent : ""}">
        <span class="summary-label">${item.label}</span>
        <span class="summary-value">${item.value}</span>
      </div>
    `).join("");

    els.debriefBox.innerHTML = buildDebriefHtml();

    els.historyTableBody.innerHTML = state.history.map((entry) => {
      const isWin = entry.wheelResult === "green";
      const pointsText = isWin ? `+${entry.pointsDelta}` : `\u2212${Math.abs(entry.pointsDelta)}`;
      return `
        <tr>
          <td>${entry.spinNumber}</td>
          <td><span class="result-pill ${entry.wheelResult}">${isWin ? "Green" : "Red"}</span></td>
          <td class="${isWin ? "pts-gain" : "pts-loss"}">${pointsText}</td>
          <td>${(entry.reactionTimeMs / 1000).toFixed(2)}s</td>
        </tr>
      `;
    }).join("");
  }

  /* ------------------------------------ 8. EXPORT ---------------------------------- */

  function buildExportSummary() {
    const totalDurationMs = state.history.length > 0
      ? state.history[state.history.length - 1].totalElapsedMs
      : 0;
    return {
      studentName: state.studentName,
      studentClass: state.studentClass,
      studentSection: state.studentSection,
      // Computed for the teacher's records only — the app itself never shows
      // or tracks a running score anymore, since each spin starts fresh.
      finalScore: CONFIG.initialScore + state.totalGained - state.totalLost,
      totalSpins: state.spinCount,
      greenOutcomes: state.greenCount,
      redOutcomes: state.redCount,
      maxLossPenaltyReached: state.maxPenaltyReached,
      totalExperimentDurationMs: totalDurationMs,
      initialScore: CONFIG.initialScore,
      greenReward: CONFIG.greenReward,
      lossPenaltySequence: CONFIG.penaltySequence.join(",")
    };
  }

  // Fire-and-forget POST of this session (summary + full spin history) to the
  // teacher's Google Sheet via the Apps Script Web App URL in CONFIG. Uses
  // mode:"no-cors" — the standard, reliable way to call an Apps Script Web
  // App from a static page without hitting its CORS preflight limitations.
  // The tradeoff: the response is opaque, so we can only ever report "sent"
  // (the request left the browser) or "couldn't reach it" (a network-level
  // failure) — never a definitive server-side confirmation. Local JSON/CSV
  // export remains the guaranteed backup regardless of this outcome.
  async function submitSessionToTeacherSheet(statusEl) {
    if (!CONFIG.sheetWebhookUrl || state.hasSubmitted) return;
    state.hasSubmitted = true;

    const payload = { summary: buildExportSummary(), history: state.history };
    if (statusEl) {
      statusEl.textContent = "Sending your results to your teacher's sheet…";
      statusEl.removeAttribute("data-state");
    }

    try {
      await fetch(CONFIG.sheetWebhookUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      if (statusEl) {
        statusEl.textContent = "Sent to your teacher's class sheet.";
        statusEl.setAttribute("data-state", "ok");
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = "Couldn't reach the class sheet — please let your teacher know so they can check your results.";
        statusEl.setAttribute("data-state", "error");
      }
    }
  }

  /* ------------------------------------ Theme / sound toggles ---------------------- */

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const isDark = theme === "dark";
    els.themeToggle.setAttribute("aria-pressed", String(isDark));
    els.themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    document.querySelector(".icon-theme-light").hidden = isDark;
    document.querySelector(".icon-theme-dark").hidden = !isDark;
  }

  function handleThemeToggle() {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  }

  function handleSoundToggle() {
    state.soundOn = !state.soundOn;
    els.soundToggle.setAttribute("aria-pressed", String(state.soundOn));
    els.soundToggle.setAttribute("aria-label", state.soundOn ? "Mute sound effects" : "Unmute sound effects");
    document.querySelector(".icon-sound-on").hidden = !state.soundOn;
    document.querySelector(".icon-sound-off").hidden = state.soundOn;
  }

  /* ------------------------------------ Begin / restart ---------------------------- */

  // The Begin button is always clickable now (no separate consent step) —
  // clicking it with missing details shows a red border on the card plus a
  // message, rather than the button just silently being disabled.
  function isReadyToBegin() {
    return els.studentNameInput.value.trim().length > 0 &&
      els.studentClassSelect.value !== "" &&
      els.studentSectionSelect.value !== "";
  }

  function showIdentityError() {
    els.identityCard.classList.add("has-error");
    els.submitStatus.textContent = "Please fill in your name, class, and section to begin.";
    els.submitStatus.setAttribute("data-state", "error");
  }

  function clearIdentityError() {
    els.identityCard.classList.remove("has-error");
    if (els.submitStatus.getAttribute("data-state") === "error") {
      els.submitStatus.textContent = "";
      els.submitStatus.removeAttribute("data-state");
    }
  }

  // As soon as all three fields are filled, clear any error state that was
  // showing — the student shouldn't have to click Start again just to see
  // the red border go away.
  function handleIdentityFieldChange() {
    if (isReadyToBegin()) clearIdentityError();
  }

  function handleBegin() {
    if (!isReadyToBegin()) {
      showIdentityError();
      els.identityCard.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    clearIdentityError();

    resetState();
    state.studentName = els.studentNameInput.value.trim();
    state.studentClass = els.studentClassSelect.value;
    state.studentSection = els.studentSectionSelect.value;
    state.experimentStartTime = Date.now();
    state.readyTimestamp = Date.now();

    buildWheelSvg();
    // Reset the wheel's visual rotation instantly (no transition) for a fresh session.
    const group = document.getElementById("wheelGroup");
    group.style.transition = "none";
    group.style.transform = "rotate(0deg)";

    renderExperimentReadouts();
    setWheelVisible(false);
    els.stopButton.textContent = `Keep my ${CONFIG.initialScore} points`;
    if (els.decisionQuestion) {
      els.decisionQuestion.textContent = `Would you like to spin the wheel, or keep your ${CONFIG.initialScore} points?`;
    }
    els.spinButton.textContent = "Spin the wheel";
    els.spinButton.disabled = false;
    els.submitStatus.textContent = "";
    els.submitStatus.removeAttribute("data-state");

    showScreen(els.experimentScreen);
  }

  function handleRestart() {
    // Clear the identity fields so the next student on this device has to
    // enter their own details rather than inheriting the previous student's
    // name/class/section.
    els.studentNameInput.value = "";
    els.studentClassSelect.selectedIndex = 0;
    els.studentSectionSelect.selectedIndex = 0;
    clearIdentityError();
    els.resultsSubmitStatus.textContent = "";
    els.resultsSubmitStatus.removeAttribute("data-state");
    showScreen(els.welcomeScreen);
  }

  /* ------------------------------------ 9. EVENT WIRING ---------------------------- */

  function wireEvents() {
    els.studentNameInput.addEventListener("input", handleIdentityFieldChange);
    els.studentClassSelect.addEventListener("change", handleIdentityFieldChange);
    els.studentSectionSelect.addEventListener("change", handleIdentityFieldChange);
    els.beginButton.addEventListener("click", handleBegin);

    els.spinButton.addEventListener("click", handleSpinClick);
    els.stopButton.addEventListener("click", openConfirmModal);
    els.confirmStopButton.addEventListener("click", handleConfirmStop);
    els.cancelStopButton.addEventListener("click", closeConfirmModal);
    els.confirmModal.addEventListener("click", (e) => {
      if (e.target === els.confirmModal) closeConfirmModal();
    });

    els.checkpointContinueButton.addEventListener("click", handleCheckpointContinue);
    els.checkpointStopButton.addEventListener("click", handleCheckpointStop);
    els.checkpointModal.addEventListener("click", (e) => {
      if (e.target === els.checkpointModal) handleCheckpointContinue();
    });

    els.restartButton.addEventListener("click", handleRestart);

    els.themeToggle.addEventListener("click", handleThemeToggle);
    els.soundToggle.addEventListener("click", handleSoundToggle);

    // Allow spacebar/enter on the spin button even while it's the active element
    // during a screen transition (native <button> already handles this, kept
    // here only as a defensive no-op hook for future extension).
  }

  /* ------------------------------------ Bootstrap ------------------------------------ */

  document.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    resetState();
    wireEvents();
    handleIdentityFieldChange();

    // Always open in light mode by default — the person can switch to dark
    // manually via the header toggle; we don't infer it from the OS anymore.
    applyTheme("light");
  });
})();