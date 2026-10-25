import { LengthInput } from "../../ui/LengthInput";
import {
  formatDimensions,
  formatLength,
  lengthInputValue,
} from "../../utils/units";
import { classifyOpenings } from "./classify";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { BuildingScenario } from "../../types/simulation";
import { drawLayout } from "../draw";
import { buildingError, canvasView, openingSegment } from "../geometry";
import { useStudioTheme } from "../../styles/appearance";
import {
  applyOpenings,
  buildDxf,
  dxfScale,
  suggestedWallLayers,
  type DxfDrawing,
  type OpeningChoice,
  type OpeningCandidate,
} from "./convert";
import "./DxfImport.css";

function Preview({
  building,
  candidates,
}: {
  building: BuildingScenario;
  candidates: OpeningCandidate[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    theme = useStudioTheme();
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const redraw = () => {
      drawLayout(
        target,
        building,
        null,
        undefined,
        window.devicePixelRatio || 1,
      );
      const ctx = target.getContext("2d");
      if (!ctx) return;
      const view = canvasView(target.width, target.height, building);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = `${12 * (window.devicePixelRatio || 1)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const opening of candidates) {
        const wall = building.walls.find((w) => w.id === opening.wall_id);
        if (!wall) continue;
        const [a, b] = openingSegment(opening, wall);
        const x = ((a.x + b.x) / 2) * view.scale + view.x,
          y = ((a.y + b.y) / 2) * view.scale + view.y;
        ctx.beginPath();
        ctx.arc(x, y, 10 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
        ctx.fillStyle = building.exits.some((o) => o.id === opening.id)
          ? "#176e56"
          : building.doors.some((o) => o.id === opening.id)
            ? "#5d4a22"
            : "#3b4350";
        ctx.fill();
        ctx.strokeStyle = "#86ceff";
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(opening.id.replace("dxf-opening-", ""), x, y);
      }
      ctx.restore();
    };
    const observer = new ResizeObserver(redraw);
    observer.observe(target);
    redraw();
    return () => observer.disconnect();
  }, [building, candidates, theme]);
  return (
    <canvas
      ref={canvas}
      className="dxf-preview"
      role="img"
      aria-label={`DXF review: ${building.walls.length} walls, ${building.doors.length} door candidates and ${building.exits.length} suggested exits.`}
    />
  );
}
export default function DxfImport({
  base,
  disabled,
  onApply,
  dialogRef: dialog,
}: {
  base: BuildingScenario;
  disabled?: boolean;
  onApply: (building: BuildingScenario) => boolean;
  dialogRef: RefObject<HTMLDialogElement | null>;
}) {
  const file = useRef<HTMLInputElement>(null),
    worker = useRef<Worker | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    request = useRef(0);
  const [drawing, setDrawing] = useState<DxfDrawing | null>(null),
    [filename, setFilename] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [layers, setLayers] = useState<string[]>([]),
    [scale, setScale] = useState(0.001),
    [thickness, setThickness] = useState(0.2),
    [maxGap, setMaxGap] = useState(3),
    [cropEnabled, setCropEnabled] = useState(false);
  const [crop, setCrop] = useState({ minX: 0, maxX: 1, minY: 0, maxY: 1 });
  const [choices, setChoices] = useState<{
    key: string;
    values: Record<string, OpeningChoice>;
  }>({ key: "", values: {} });
  const [removed, setRemoved] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const key = JSON.stringify({
    filename,
    layers,
    scale,
    thickness,
    maxGap,
    cropEnabled,
    crop,
  });
  const options = useMemo(
    () => ({
      layers,
      scale,
      thickness,
      maxGap,
      ...(cropEnabled ? { crop } : {}),
    }),
    [layers, scale, thickness, maxGap, cropEnabled, crop],
  );
  const conversion = useMemo(() => {
    if (!drawing) return null;
    try {
      return { data: buildDxf(drawing, options, base), error: "" };
    } catch (e) {
      return {
        data: null,
        error: e instanceof Error ? e.message : "Conversion failed.",
      };
    }
  }, [drawing, options, base]);
  const data = conversion?.data;
  const removedIds = removed.key === key ? removed.ids : [];
  const walls = data?.building.walls.filter((w) => !removedIds.includes(w.id));
  const candidates =
    data?.openings.filter((o) => walls?.some((w) => w.id === o.wall_id)) ?? [];
  const guesses = useMemo(
    () =>
      drawing && data
        ? classifyOpenings(drawing, options, data.building, data.openings)
        : {},
    [drawing, options, data],
  );
  const defaults = Object.fromEntries(
    Object.entries(guesses).map(([id, guess]) => [id, guess.role]),
  );
  const selectedChoices: Record<string, OpeningChoice> = {
    ...defaults,
    ...(choices.key === key ? choices.values : {}),
  };
  const reviewedBuilding = data
    ? { ...data.building, walls: walls ?? [] }
    : null;
  const preview = reviewedBuilding
    ? applyOpenings(reviewedBuilding, candidates, selectedChoices, true)
    : null;
  const pending = candidates.filter(
    (o) => !selectedChoices[o.id] || selectedChoices[o.id] === "review",
  ).length;
  const stop = () => {
    worker.current?.terminate();
    worker.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      request.current++;
      worker.current?.terminate();
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function readFile(selected?: File) {
    if (!selected) return;
    stop();
    const id = ++request.current;
    setError("");
    setDrawing(null);
    if (
      !selected.name.toLowerCase().endsWith(".dxf") ||
      selected.size > 5_000_000
    ) {
      setError("Choose an ASCII .dxf file smaller than 5 MB.");
      return;
    }
    setBusy(true);
    setFilename(selected.name);
    try {
      const text = await selected.text();
      if (id !== request.current) return;
      const parser = new Worker(new URL("./dxf.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current = parser;
      parser.onmessage = (
        event: MessageEvent<{ drawing?: DxfDrawing; error?: string }>,
      ) => {
        if (id !== request.current) return;
        stop();
        setBusy(false);
        if (event.data.error || !event.data.drawing) {
          setError(event.data.error ?? "No geometry found.");
          return;
        }
        const next = event.data.drawing;
        setDrawing(next);
        setScale(dxfScale(next.units) ?? 0.001);
        setLayers(suggestedWallLayers(next));
        const points = next.strokes.flatMap((s) => [s.start, s.end]);
        setCrop({
          minX: Math.min(...points.map((p) => p.x)),
          maxX: Math.max(...points.map((p) => p.x)),
          minY: Math.min(...points.map((p) => p.y)),
          maxY: Math.max(...points.map((p) => p.y)),
        });
        setCropEnabled(false);
        setChoices({ key: "", values: {} });
        setRemoved({ key: "", ids: [] });
      };
      parser.onerror = () => {
        if (id !== request.current) return;
        stop();
        setBusy(false);
        setError("DXF parser failed. Try exporting a 2D ASCII DXF.");
      };
      timer.current = setTimeout(() => {
        if (id !== request.current) return;
        stop();
        setBusy(false);
        setError("Parsing timed out. Export only the floor-plan region.");
      }, 8000);
      parser.postMessage(text);
    } catch (e) {
      if (id !== request.current) return;
      stop();
      setBusy(false);
      setError(e instanceof Error ? e.message : "Could not read file.");
    }
  }
  function close() {
    request.current++;
    stop();
    setBusy(false);
    dialog.current?.close();
  }
  return (
    <>
      <dialog
        ref={dialog}
        className="dxf-dialog"
        aria-labelledby="dxf-title"
        onCancel={close}
      >
        <div className="dxf-heading">
          <div>
            <p className="eyebrow">IMPORT → REVIEW → EDIT → SIMULATE</p>
            <h2 id="dxf-title">Import a DXF floor plan</h2>
          </div>
          <button type="button" onClick={close} aria-label="Close DXF import">
            ✕
          </button>
        </div>
        <p>
          Walls and opening roles are suggested automatically. Review the
          preview before replacing the editor layout. Your current drawing stays
          unchanged until you apply; Undo restores it afterward.
        </p>
        <button
          type="button"
          onClick={() => file.current?.click()}
          disabled={busy}
        >
          Choose DXF file
        </button>
        <input
          ref={file}
          type="file"
          accept=".dxf"
          hidden
          onChange={(event) => {
            void readFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <span className="dxf-filename">{filename}</span>
        {busy && <p role="status">Reading DXF geometry…</p>}
        {error && (
          <p role="alert" className="dxf-error">
            {error}
          </p>
        )}
        {drawing && (
          <>
            <div className="dxf-settings">
              <fieldset>
                <legend>1 · Choose wall layers / blocks</legend>
                {[...new Set(drawing.strokes.map((s) => s.layer))].map(
                  (layer) => (
                    <label key={layer}>
                      <input
                        type="checkbox"
                        checked={layers.includes(layer)}
                        onChange={(e) =>
                          setLayers((old) =>
                            e.target.checked
                              ? [...old, layer]
                              : old.filter((l) => l !== layer),
                          )
                        }
                      />
                      {layer} (
                      {drawing.strokes.filter((s) => s.layer === layer).length}{" "}
                      segments)
                    </label>
                  ),
                )}
              </fieldset>
              <fieldset>
                <legend>2 · Scale and detection</legend>
                <p>
                  DXF unit code: {drawing.units}
                  {dxfScale(drawing.units) === null
                    ? " — units unknown; confirm scale before importing."
                    : " — verify dimensions below."}
                </p>
                <label>
                  Feet per DXF unit
                  <LengthInput
                    min={0.000001}
                    precision={8}
                    value={scale}
                    onValue={setScale}
                  />
                </label>
                <p>Feet: 1 · Inches: 0.08333333 · Millimeters: 0.00328084</p>
                <label>
                  Line-wall thickness (ft)
                  <LengthInput
                    min={0.01}
                    max={2}
                    value={thickness}
                    onValue={setThickness}
                  />
                </label>
                <label>
                  Detect gaps up to (ft)
                  <LengthInput
                    min={0}
                    max={5}
                    value={maxGap}
                    onValue={setMaxGap}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={cropEnabled}
                    onChange={(e) => setCropEnabled(e.target.checked)}
                  />
                  Crop plan region (original DXF units)
                </label>
                {cropEnabled &&
                  Object.entries(crop).map(([name, value]) => (
                    <label key={name}>
                      {name}
                      <input
                        type="number"
                        step="any"
                        value={value}
                        onChange={(e) =>
                          setCrop((old) => ({
                            ...old,
                            [name]: e.target.valueAsNumber,
                          }))
                        }
                      />
                    </label>
                  ))}
              </fieldset>
            </div>
            {conversion?.error && (
              <p role="alert" className="dxf-error">
                {conversion.error}
              </p>
            )}
            {preview && data && (
              <>
                <h3>3 · Review detected geometry</h3>
                <p>
                  {formatDimensions(preview.width, preview.height, 2)} workspace
                  (includes {formatLength(1)} margins) · {preview.walls.length}{" "}
                  walls · {candidates.length} opening suggestions
                </p>
                <Preview building={preview} candidates={candidates} />
                {drawing.warnings.length > 0 && (
                  <p className="note">
                    Some source entities were omitted. Review the import notes
                    below before applying.
                  </p>
                )}
                <details>
                  <summary>Review / exclude individual walls</summary>
                  <div className="dxf-wall-list">
                    {data.building.walls.map((w) => (
                      <label key={w.id}>
                        <input
                          type="checkbox"
                          checked={!removedIds.includes(w.id)}
                          onChange={(e) =>
                            setRemoved({
                              key,
                              ids: e.target.checked
                                ? removedIds.filter((id) => id !== w.id)
                                : [...removedIds, w.id],
                            })
                          }
                        />
                        {w.id} · ({lengthInputValue(w.start.x, 2)},{" "}
                        {lengthInputValue(w.start.y, 2)}) → (
                        {lengthInputValue(w.end.x, 2)},{" "}
                        {lengthInputValue(w.end.y, 2)}) ft · thickness{" "}
                        {formatLength(w.thickness, 2)}
                      </label>
                    ))}
                  </div>
                </details>
                <h3>4 · Automatic door / exit suggestions</h3>
                <p>
                  Roles are prefilled using source layers and geometry. Window
                  gaps stay sealed; door symbols suggest doors; doors on the
                  outer plan extent suggest exits. The outer extent is only a
                  heuristic, so verify exits lead outdoors. Uncertain gaps stay
                  sealed. You can override any suggestion below.
                </p>
                <p>
                  {preview.walls.length} walls · {preview.doors.length} doors ·{" "}
                  {preview.exits.length} suggested exits ·{" "}
                  {
                    candidates.filter(
                      (o) => guesses[o.id]?.confidence === "uncertain",
                    ).length
                  }{" "}
                  uncertain gaps sealed by default
                </p>
                {candidates.length ? (
                  <details>
                    <summary>Inspect or override automatic roles</summary>
                    <div className="dxf-opening-list">
                      {candidates.map((o) => (
                        <label key={o.id}>
                          {o.id} · {o.wall_id} · {formatLength(o.width, 2)}
                          <select
                            aria-label={`Role for ${o.id}`}
                            value={selectedChoices[o.id] ?? "review"}
                            onChange={(e) =>
                              setChoices({
                                key,
                                values: {
                                  ...(choices.key === key
                                    ? choices.values
                                    : {}),
                                  [o.id]: e.target.value as OpeningChoice,
                                },
                              })
                            }
                          >
                            <option value="review">Choose role…</option>
                            <option value="door">Door</option>
                            <option value="exit">Emergency exit</option>
                            <option value="closed">Seal gap</option>
                          </select>
                          <small className="dxf-guess">
                            {guesses[o.id]?.reason}{" "}
                            {choices.key === key && choices.values[o.id]
                              ? "(Your override)"
                              : "(Automatic suggestion)"}
                          </small>
                        </label>
                      ))}
                    </div>
                  </details>
                ) : (
                  <p>
                    No gaps were inferred. Add doors and exits with the existing
                    editor tools after importing.
                  </p>
                )}
                <details>
                  <summary>Import notes and omitted geometry</summary>
                  <ul>
                    {data.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                  <p>
                    Straight LINE/POLYLINE entities and ordinary 2D blocks are
                    supported. Curves, array/3D blocks, text and dimensions are
                    omitted. Layer names include block names so you can exclude
                    sections and title blocks. Export or explode unsupported
                    geometry first. Wall detection is assisted and must be
                    reviewed.
                  </p>
                </details>
                <p>
                  After applying: review wall joins, place occupants in spawn
                  zones, then use Run simulation. No occupants or exit
                  connectivity are invented from the drawing.
                </p>
                <button
                  className="primary"
                  type="button"
                  disabled={pending > 0 || !preview.walls.length || disabled}
                  onClick={() => {
                    try {
                      const next = applyOpenings(
                        reviewedBuilding!,
                        candidates,
                        selectedChoices,
                      );
                      const problem = buildingError(next, false);
                      if (problem) throw new Error(problem);
                      if (onApply(next)) {
                        close();
                      }
                    } catch (e) {
                      setError(
                        e instanceof Error
                          ? e.message
                          : "Import validation failed.",
                      );
                    }
                  }}
                >
                  Use detected layout in editor
                  {pending ? ` (${pending} openings to review)` : ""}
                </button>
              </>
            )}
          </>
        )}
      </dialog>
    </>
  );
}
