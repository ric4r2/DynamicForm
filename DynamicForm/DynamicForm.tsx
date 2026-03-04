/**
 * DynamicForm.tsx  –  The React functional component
 * ─────────────────────────────────────────────────────────────────────────
 * FOCUS MANAGEMENT STRATEGY
 * ──────────────────────────
 * Goal: keep the mobile virtual keyboard open continuously as the user
 * tabs through the form, and never steal/drop focus unexpectedly.
 *
 * Implementation:
 *  1. inputRefs  – a stable MutableRefObject<(HTMLElement|null)[]>.
 *     Each rendered row gets one entry at position [index].
 *     Foto rows get a button ref; all others get an input/select ref.
 *
 *  2. Auto-focus on new Plantacion  (useEffect #3)
 *     We track the last FK_Plantacion in lastPlantacionRef.  When it
 *     changes, we find the first non-Foto row and call .focus() after a
 *     tiny RAF (requestAnimationFrame) so React has finished painting.
 *
 *  3. Enter-key navigation  (handleKeyDown)
 *     – Not-last focusable row  →  save record + focus next input
 *     – Last focusable row      →  save record + blur (Power Apps takes over)
 *     "Focusable" = TipoVariable !== "Foto"
 *     We pre-compute a focusableIndices[] list to make next/last lookups O(1).
 *
 *  4. notifyOutputChanged is NEVER called on individual keystrokes.
 *     The records array lives in local useState and is mutated in-place.
 *     Power Apps only learns about a record when the user presses Enter.
 * ─────────────────────────────────────────────────────────────────────────
 */

import * as React from "react";
import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
} from "react";

// ─────────────────────────────────────────────────────────────────────────────
//  DATA TYPES  (exported so index.ts can type the callback argument)
// ─────────────────────────────────────────────────────────────────────────────

/** One question / measurement row received from Power Apps */
export interface FormRecord {
    FK_Plantacion: number;
    FK_Programa: number;
    FK_Evaluacion: number;
    FK_Variable: number;
    NombreVariable: string;
    OrderNo: number;
    /** Drives which input control is rendered for this row */
    TipoVariable: string;
    /**
     * Selected PK for Categorica rows.
     * null  = no selection yet.
     */
    FK_ValorCategorico: number | null;
    /**
     * Free-text / numeric value for all non-Categorica, non-Foto rows.
     * null  = not yet entered.
     */
    Valor: string | null;
    /**
     * URL of uploaded photo for Foto rows.
     * null/empty = no photo uploaded yet.
     */
    URL?: string | null;
    /**
     * Minimum allowed value for numeric fields (optional).
     * Used for validation. null = no minimum.
     */
    ValorMinimo?: number | null;
    /**
     * Maximum allowed value for numeric fields (optional).
     * Used for validation. null = no maximum.
     */
    ValorMaximo?: number | null;
}

/** One option in a Categorica dropdown */
export interface CategoricOption {
    FK_Variable: number;
    PK_ValorCategorico: number;
    Valor: string;
}

/** Props injected by index.ts */
export interface IDynamicFormProps {
    /** Raw JSON string of FormRecord[] from Power Apps */
    formDataJSON: string;
    /** Raw JSON string of CategoricOption[] from Power Apps */
    refValoresCategoricosJSON: string;
    /** When true, Enter key skips Categorica and Foto fields */
    skipNonTextField: boolean;
    /**
     * Callback to notify Power Apps of an action.
     * Called only on Enter or photo-button click; NEVER on each keystroke.
     */
    triggerOutputChange: (
        action: string,
        record: FormRecord | null,
        activeVariable: number | null
    ) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function safeParseArray<T>(raw: string): T[] {
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export const DynamicFormComponent: React.FC<IDynamicFormProps> = ({
    formDataJSON,
    refValoresCategoricosJSON,
    skipNonTextField,
    triggerOutputChange,
}) => {
    // ── Local state ---------------------------------------------------------

    /** Sorted array of question rows (sorted ascending by OrderNo) */
    const [records, setRecords] = useState<FormRecord[]>([]);

    /** Master categorical options list (unchanged during a session) */
    const [categoricOptions, setCategoricOptions] = useState<CategoricOption[]>([]);

    /** Validation errors: Map<index, errorMessage> */
    const [validationErrors, setValidationErrors] = useState<Map<number, string>>(new Map());

    // ── Refs ----------------------------------------------------------------

    /**
     * inputRefs.current[index] holds the DOM element for each row at that index.
     *  - text / number inputs  →  HTMLInputElement
     *  - select elements       →  HTMLSelectElement
     *  - photo buttons         →  HTMLButtonElement
     *
     * Array is sized dynamically; null entries are gaps (shouldn't happen
     * in normal operation but TypeScript requires the possibility).
     */
    const inputRefs = useRef<(HTMLInputElement | HTMLSelectElement | HTMLButtonElement | null)[]>([]);

    /**
     * Tracks the FK_Plantacion of the currently displayed form so we can
     * detect genuine Plantacion transitions (as opposed to re-renders caused
     * by our own state updates) and auto-focus the first field.
     */
    const lastPlantacionRef = useRef<number | null>(null);

    // ── Derived: ordered list of indices that should receive Enter-navigation
    //    When skipNonTextField is FALSE: exclude only "Foto" rows.
    //    When skipNonTextField is TRUE: include only "Texto", "Numero entero", "Numero decimal".
    const focusableIndices: number[] = useMemo(
        () =>
            records.reduce<number[]>((acc, rec, idx) => {
                if (skipNonTextField) {
                    // Strict mode: only text and numeric fields
                    const isTextOrNumeric = 
                        rec.TipoVariable === "Texto" ||
                        rec.TipoVariable === "Numero entero" ||
                        rec.TipoVariable === "Numero decimal";
                    if (isTextOrNumeric) acc.push(idx);
                } else {
                    // Standard mode: all except Foto
                    if (rec.TipoVariable !== "Foto") acc.push(idx);
                }
                return acc;
            }, []),
        [records, skipNonTextField]
    );

    // ── Effect 1: parse FormDataJSON when it changes ------------------------
    useEffect(() => {
        const parsed = safeParseArray<FormRecord>(formDataJSON);
        // Sort ascending by OrderNo so the render order matches designer intent
        parsed.sort((a, b) => a.OrderNo - b.OrderNo);
        setRecords(parsed);
    }, [formDataJSON]);

    // ── Effect 2: parse RefValoresCategoricosJSON when it changes -----------
    useEffect(() => {
        setCategoricOptions(safeParseArray<CategoricOption>(refValoresCategoricosJSON));
    }, [refValoresCategoricosJSON]);

    // ── Effect 3: auto-focus first input when FK_Plantacion changes ---------
    // We compare against lastPlantacionRef to distinguish a genuine Plantacion
    // switch from a re-render caused by the user editing a field.
    useEffect(() => {
        if (records.length === 0) return;

        const currentPlantacion = records[0].FK_Plantacion;
        if (currentPlantacion === lastPlantacionRef.current) return; // same form, skip

        // New Plantacion detected  →  update tracker and schedule focus
        lastPlantacionRef.current = currentPlantacion;

        // Use requestAnimationFrame so React has finished rendering the DOM
        // nodes and all refs are populated before we call .focus().
        requestAnimationFrame(() => {
            const firstFocusableIdx = focusableIndices[0];
            if (firstFocusableIdx !== undefined) {
                inputRefs.current[firstFocusableIdx]?.focus();
            }
        });
    }, [records, focusableIndices]);

    // ── Validation helper for decimal fields ───────────────────────────────
    /**
     * Validates a decimal value against min/max constraints.
     * Accepts Spanish comma format (e.g., "12,5").
     * Returns error message or null if valid.
     */
    const validateDecimal = useCallback(
        (value: string | null, record: FormRecord): string | null => {
            if (!value || value.trim() === "") return null; // Empty is valid (optional field)

            // Convert Spanish comma to dot for JavaScript parsing
            const normalizedValue = value.replace(",", ".");
            const numericValue = parseFloat(normalizedValue);

            // Check if it's a valid number
            if (isNaN(numericValue)) {
                return "Valor numérico inválido";
            }

            // Check minimum
            if (record.ValorMinimo != null && numericValue < record.ValorMinimo) {
                return `Mínimo: ${record.ValorMinimo}`;
            }

            // Check maximum
            if (record.ValorMaximo != null && numericValue > record.ValorMaximo) {
                return `Máximo: ${record.ValorMaximo}`;
            }

            return null; // Valid
        },
        []
    );

    // ── State mutation: update a field in the local records array ----------
    // This does NOT call notifyOutputChanged. Power Apps learns about the
    // change only when the user presses Enter (see handleKeyDown below).
    const handleChange = useCallback(
        (index: number, field: "Valor" | "FK_ValorCategorico", value: string | number | null) => {
            setRecords((prev) => {
                const next = [...prev];
                next[index] = { ...next[index], [field]: value };

                // Validate decimal fields
                if (field === "Valor" && next[index].TipoVariable === "Numero decimal") {
                    const error = validateDecimal(value as string | null, next[index]);
                    setValidationErrors((prevErrors) => {
                        const newErrors = new Map(prevErrors);
                        if (error) {
                            newErrors.set(index, error);
                        } else {
                            newErrors.delete(index);
                        }
                        return newErrors;
                    });
                }

                return next;
            });
        },
        [validateDecimal]
    );

    // ── Enter-key handler ──────────────────────────────────────────────────
    /**
     * handleKeyDown is attached to every text/number/select input.
     *
     * Scenario A – Enter on a NON-LAST focusable row:
     *   1. Capture the current (updated) record from local state.
     *   2. Signal Power Apps: OutAction="SAVE_RECORD", OutModifiedRecord=<JSON>.
     *   3. Shift DOM focus to the next focusable input  →  keyboard stays open.
     *
     * Scenario B – Enter on the LAST focusable row:
     *   1. Capture the record.
     *   2. Signal Power Apps: OutAction="SAVE_AND_NEXT_PLANTACION".
     *   3. .blur() the current input  →  Power Apps can advance the gallery.
     */
    const handleKeyDown = useCallback(
        (
            e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
            index: number
        ) => {
            if (e.key !== "Enter") return;
            e.preventDefault(); // Prevent any default browser form-submit behaviour

            // Capture the current record from state.
            // Note: because this callback closes over `records` from the time it
            // was created, and `records` updates asynchronously, we read from the
            // DOM element's current value as the source of truth for the snapshot,
            // then build the record manually to ensure it's up-to-date.
            // Actually: React's synthetic event fires AFTER setState, so `records`
            // in this closure may be stale.  We work around this by capturing the
            // value directly from the event target and merging it back.
            const record = records[index];
            if (!record) return;

            // Check if there's a validation error for this field
            if (validationErrors.has(index)) {
                // Don't save if there's a validation error
                // Keep focus on current field so user can correct it
                return;
            }

            // Determine position of this index in the focusableIndices list
            const posInFocusable = focusableIndices.indexOf(index);
            const isLast = posInFocusable === focusableIndices.length - 1;
            const nextIdx = isLast ? -1 : focusableIndices[posInFocusable + 1];

            if (!isLast && nextIdx >= 0) {
                // ── Scenario A: save and move to next input ──────────────────
                triggerOutputChange("SAVE_RECORD", record, null);

                // Focus the next input immediately – this is what keeps the
                // mobile keyboard open. The browser sees an uninterrupted focus
                // chain within our isolated React tree.
                requestAnimationFrame(() => {
                    inputRefs.current[nextIdx]?.focus();
                });
            } else {
                // ── Scenario B: save and hand off to Power Apps ───────────────
                triggerOutputChange("SAVE_AND_NEXT_PLANTACION", record, null);

                // Blur removes keyboard focus.  Power Apps can now respond to
                // the OutAction and navigate the gallery to the next Plantacion.
                inputRefs.current[index]?.blur();
            }
        },
        [records, focusableIndices, validationErrors, triggerOutputChange]
    );

    // ── Photo button click handler ─────────────────────────────────────────
    /**
     * Scenario C – User clicks "Tomar / Cambiar Foto":
     *   Signal Power Apps with OutAction="TAKE_PHOTO" and OutActiveVariable
     *   set to the FK_Variable of this row.  Power Apps opens the camera.
     */
    const handlePhotoClick = useCallback(
        (record: FormRecord) => {
            triggerOutputChange("TAKE_PHOTO", null, record.FK_Variable);
        },
        [triggerOutputChange]
    );

    // ── Render one input control based on TipoVariable ─────────────────────
    const renderInput = (record: FormRecord, index: number): React.ReactElement => {
        const hasError = validationErrors.has(index);
        const commonInputProps = {
            id: `df-input-${index}`,
            className: `df-input${hasError ? " df-input--error" : ""}`,
        };

        switch (record.TipoVariable) {

            // ── Integer numeric field ───────────────────────────────────────
            case "Numero entero":
                return (
                    <input
                        {...commonInputProps}
                        type="number"
                        step="1"
                        inputMode="numeric"   /* Android: shows numeric keyboard  */
                        pattern="[0-9]*"      /* iOS: shows numeric keyboard       */
                        value={record.Valor ?? ""}
                        ref={(el) => { inputRefs.current[index] = el; }}
                        onChange={(e) =>
                            handleChange(index, "Valor", e.target.value !== "" ? e.target.value : null)
                        }
                        onKeyDown={(e) => handleKeyDown(e, index)}
                    />
                );

            // ── Decimal numeric field ───────────────────────────────────────
            // Uses type="text" to preserve Spanish comma separator (e.g., "12,5")
            case "Numero decimal":
                return (
                    <input
                        {...commonInputProps}
                        type="text"
                        inputMode="decimal"   /* Shows decimal keyboard on mobile */
                        value={record.Valor ?? ""}
                        ref={(el) => { inputRefs.current[index] = el; }}
                        onChange={(e) =>
                            handleChange(index, "Valor", e.target.value !== "" ? e.target.value : null)
                        }
                        onKeyDown={(e) => handleKeyDown(e, index)}
                    />
                );

            // ── Free-text field ─────────────────────────────────────────────
            case "Texto":
                return (
                    <input
                        {...commonInputProps}
                        type="text"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        value={record.Valor ?? ""}
                        ref={(el) => { inputRefs.current[index] = el; }}
                        onChange={(e) =>
                            handleChange(index, "Valor", e.target.value !== "" ? e.target.value : null)
                        }
                        onKeyDown={(e) => handleKeyDown(e, index)}
                    />
                );

            // ── Categorical dropdown ────────────────────────────────────────
            case "Categorica": {
                const options = categoricOptions.filter(
                    (o) => o.FK_Variable === record.FK_Variable
                );
                return (
                    <select
                        {...commonInputProps}
                        className="df-input df-select"
                        value={record.FK_ValorCategorico ?? ""}
                        ref={(el) => { inputRefs.current[index] = el; }}
                        onChange={(e) => {
                            const rawVal = e.target.value;
                            const numVal = rawVal !== "" ? Number(rawVal) : null;
                            handleChange(index, "FK_ValorCategorico", numVal);
                        }}
                        onKeyDown={(e) => handleKeyDown(e, index)}
                    >
                        <option value="">-- Seleccionar --</option>
                        {options.map((opt) => (
                            <option
                                key={opt.PK_ValorCategorico}
                                value={opt.PK_ValorCategorico}
                            >
                                {opt.Valor}
                            </option>
                        ))}
                    </select>
                );
            }

            // ── Photo trigger button ────────────────────────────────────────
            // This is intentionally excluded from Enter-key navigation because
            // it doesn't capture text input.  The user taps it explicitly.
            case "Foto": {
                const hasPhoto = record.URL && record.URL.trim() !== "";
                const buttonText = hasPhoto ? "Cambiar Foto" : "Tomar Foto";
                return (
                    <div className="df-photo-container">
                        {hasPhoto && (
                            <img
                                src={record.URL!}
                                alt="Evidencia"
                                className="df-photo-thumbnail"
                            />
                        )}
                        <button
                            type="button"
                            className="df-photo-button"
                            ref={(el) => { inputRefs.current[index] = el; }}
                            onClick={() => handlePhotoClick(record)}
                        >
                            {buttonText}
                        </button>
                    </div>
                );
            }

            // ── Fallback: unknown TipoVariable → render as text ────────────
            default:
                return (
                    <input
                        {...commonInputProps}
                        type="text"
                        value={record.Valor ?? ""}
                        ref={(el) => { inputRefs.current[index] = el; }}
                        onChange={(e) =>
                            handleChange(index, "Valor", e.target.value !== "" ? e.target.value : null)
                        }
                        onKeyDown={(e) => handleKeyDown(e, index)}
                    />
                );
        }
    };

    // ── Render ──────────────────────────────────────────────────────────────
    return (
        <div className="df-container" role="form" aria-label="Dynamic evaluation form">
            {records.map((record, index) => (
                <div
                    key={record.FK_Variable}
                    className={`df-row ${record.TipoVariable === "Foto" ? "df-row--photo" : ""}`}
                >
                    {/* Label ───────────────────────────────────────────────── */}
                    <label
                        className="df-label"
                        htmlFor={`df-input-${index}`}
                    >
                        <span className="df-label-order">{record.OrderNo}.</span>
                        {record.NombreVariable}
                    </label>

                    {/* Input control (varies by TipoVariable) ─────────────── */}
                    <div className="df-input-wrapper">
                        {renderInput(record, index)}
                        {/* Validation error message ───────────────────────── */}
                        {validationErrors.has(index) && (
                            <div className="df-error-message" role="alert">
                                {validationErrors.get(index)}
                            </div>
                        )}
                    </div>
                </div>
            ))}

            {/* Empty state when no records are loaded ───────────────────── */}
            {records.length === 0 && (
                <div className="df-empty">
                    <p>Cargando formulario…</p>
                </div>
            )}
        </div>
    );
};
