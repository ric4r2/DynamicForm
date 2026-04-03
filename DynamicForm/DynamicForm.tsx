/**
 * DynamicForm.tsx  –  The React functional component
 * 
─────────────────────────────────────────────────────────────────────────
 * FOCUS MANAGEMENT STRATEGY
 * 
──────────────────────────
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
 *     – Last focusable row      
→  save record + blur (Power Apps takes over)
 *     "Focusable" = TipoVariable !== "Foto"
 *     We pre-compute a focusableIndices[] list to make next/last lookups O(1).
 *
 *  4. notifyOutputChanged is NEVER called on individual keystrokes.
 *     The records array lives in local useState and is mutated in-place.
 *     Power Apps only learns about a record when the user presses Enter.
 * 
─────────────────────────────────────────────────────────────────────────
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
        activeVariable: number | null,
        allRecords: FormRecord[] | null
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
/**
 * Strips leading numbers and dots from variable names.
 * Example: "1. Estado" → "Estado"
 */
function cleanVariableName(name: string): string {
    // Remove leading pattern like "1. " or "12. " etc.
    return name.replace(/^\d+\.\s*/, "").trim();
}

/**
 * Sanitizes input for decimal fields.
 * Keeps only digits plus one decimal separator and normalizes it to comma.
 */
function sanitizeDecimal(value: string): string | null {
    const normalized = value.replace(/\./g, ",").replace(/[^0-9,]/g, "");
    const firstComma = normalized.indexOf(",");

    if (firstComma === -1) {
        return normalized !== "" ? normalized : null;
    }

    const intPart = normalized.slice(0, firstComma);
    const fracPart = normalized.slice(firstComma + 1).replace(/,/g, "");
    const combined = `${intPart},${fracPart}`;
    return combined !== "" ? combined : null;
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
     * Debounce ref for last-field submission.
     * Tracks the timestamp of the last SAVE_AND_NEXT_PLANTACION trigger to prevent
     * multiple rapid submissions when user taps Enter multiple times quickly.
     */
    const lastSubmissionTimeRef = useRef<number>(0);
    const DEBOUNCE_MS = 500;

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
    // 
// ── Effect 1: parse FormDataJSON when it changes -----------------------
    useEffect(() => {
        const parsed = safeParseArray<FormRecord>(formDataJSON);
        // Sort ascending by OrderNo so the render order matches designer intent
        parsed.sort((a, b) => a.OrderNo - b.OrderNo);
        setRecords(parsed);
    }, [formDataJSON]);
    // 
// ── Effect 2: parse RefValoresCategoricosJSON when it changes ----------
    useEffect(() => {
        setCategoricOptions(safeParseArray<CategoricOption>(refValoresCategoricosJSON));
    }, [refValoresCategoricosJSON]);
    // 
// ── Effect 3: auto-focus first input when FK_Plantacion changes --------
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
    // 
// ── Integer sanitization helper ──────────────────────────────────────────
    /**
     * Sanitizes input for integer fields.
     * Strips all non-digit characters (commas, dots, minus signs, letters).
     * Returns pure numeric string or null.
     */
    const sanitizeInteger = useCallback((value: string): string | null => {
        const cleanValue = value.replace(/[^0-9]/g, "");
        return cleanValue !== "" ? cleanValue : null;
    }, []);
    // 
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
            // Check minimum and maximum - show range if both exist
            if (record.ValorMinimo != null && record.ValorMaximo != null) {
                if (numericValue < record.ValorMinimo || numericValue > record.ValorMaximo) {
                    return `El valor debe estar entre ${record.ValorMinimo} y ${record.ValorMaximo}`;
                }
            } else if (record.ValorMinimo != null && numericValue < record.ValorMinimo) {
                return `El valor mínimo es ${record.ValorMinimo}`;
            } else if (record.ValorMaximo != null && numericValue > record.ValorMaximo) {
                return `El valor máximo es ${record.ValorMaximo}`;
            }
            return null; // Valid
        },
        []
    );
    //
// ── Validation helper for integer fields ───────────────────────────────
    /**
     * Validates an integer value against min/max constraints.
     * Returns error message or null if valid.
     */
    const validateInteger = useCallback(
        (value: string | null, record: FormRecord): string | null => {
            if (!value || value.trim() === "") return null;
            const numericValue = parseInt(value, 10);
            if (isNaN(numericValue)) {
                return "Valor numérico inválido";
            }
            if (record.ValorMinimo != null && record.ValorMaximo != null) {
                if (numericValue < record.ValorMinimo || numericValue > record.ValorMaximo) {
                    return `El valor debe estar entre ${record.ValorMinimo} y ${record.ValorMaximo}`;
                }
            } else if (record.ValorMinimo != null && numericValue < record.ValorMinimo) {
                return `El valor mínimo es ${record.ValorMinimo}`;
            } else if (record.ValorMaximo != null && numericValue > record.ValorMaximo) {
                return `El valor máximo es ${record.ValorMaximo}`;
            }
            return null;
        },
        []
    );
    //
// ── State mutation: update a field in the local records array ---------
    // This does NOT call notifyOutputChanged. Power Apps learns about the
    // change only when the user presses Enter (see handleKeyDown below).
    const handleChange = useCallback(
        (index: number, field: "Valor" | "FK_ValorCategorico", value: string | number | null) => {
            setRecords((prev) => {
                const next = [...prev];
                next[index] = { ...next[index], [field]: value };
                if (field === "Valor") {
                    const tipo = next[index].TipoVariable;
                    let error: string | null = null;
                    if (tipo === "Numero decimal") {
                        error = validateDecimal(value as string | null, next[index]);
                    } else if (tipo === "Numero entero") {
                        error = validateInteger(value as string | null, next[index]);
                    }
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
        [validateDecimal, validateInteger]
    );
    // 
// ── Shared emitter for all Power Apps notifications ─────────────────────
    /**
     * Single output path for all actions (Enter + Foto click) so both
     * interaction types execute identical PCF notification logic.
     */
    const emitToPowerApps = useCallback(
        (actionName: string, record: FormRecord | null, activeVariable: number | null) => {
            console.log("[DynamicForm UI] emitToPowerApps", {
                actionName,
                fkVariable: record?.FK_Variable ?? null,
                activeVariable,
            });
            // Keep action names stable for Power Fx comparisons.
            // Event uniqueness is handled by OutEventTick in index.ts.
            triggerOutputChange(actionName, record, activeVariable, records);
        },
        [triggerOutputChange, records]
    );
    // 
// ── Core save-and-navigate logic ────────────────────────────────────────
    const commitEnterAction = useCallback(
        (index: number) => {
            const record = records[index];
            if (!record) return;
            // Don't emit while field has a validation error.
            if (validationErrors.has(index)) {
                return;
            }
            // Determine position of this index in the focusableIndices list.
            const posInFocusable = focusableIndices.indexOf(index);
            const isLast = posInFocusable === focusableIndices.length - 1;
            if (!isLast) {
                emitToPowerApps("SAVE_RECORD", record, null);
            } else {
                emitToPowerApps("SAVE_AND_NEXT_PLANTACION", record, null);
            }
        },
        [records, validationErrors, focusableIndices, emitToPowerApps]
    );
    // 
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
     *
     * MOBILE NOTE: On Android, IME composition can mask key events (keyCode 229).
     * We check isComposing to ignore those events. The form onSubmit handler
     * below provides a more reliable fallback for mobile keyboards.
     */
    const handleKeyDown = useCallback(
        (
            e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
            index: number
        ) => {
            if (e.key !== "Enter") return;
            e.preventDefault();

            const record = records[index];
            const isNumberField =
                record.TipoVariable === "Numero entero" ||
                record.TipoVariable === "Numero decimal";

            // If the number field has an active validation error, clear the value and stay.
            if (isNumberField && validationErrors.has(index)) {
                handleChange(index, "Valor", null);
                return;
            }

            const posInFocusable = focusableIndices.indexOf(index);
            const isLast = posInFocusable === focusableIndices.length - 1;

            if (isLast) {
                // Last focusable input: keep existing behavior (click hidden test button).
                const testBtn = document.getElementById(`test-btn-${index}`);
                if (testBtn) testBtn.click();
                return;
            }

            // Non-last input: shift focus to the next focusable input.
            const nextIdx = focusableIndices[posInFocusable + 1];
            if (nextIdx !== undefined) {
                inputRefs.current[nextIdx]?.focus();
            }
        },
        [records, focusableIndices, validationErrors, handleChange]
    );
    /**
     * Form submit handler for mobile keyboards.
     * Mobile OS (Android/iOS) fires form submission when user taps the
     * "Go", "Next", or "Done" button on the virtual keyboard.
     * This is more reliable than onKeyDown on mobile devices.
     */
    const handleFormSubmit = useCallback(
        (e: React.FormEvent, index: number) => {
            e.preventDefault();

            const record = records[index];
            const isNumberField =
                record.TipoVariable === "Numero entero" ||
                record.TipoVariable === "Numero decimal";

            // If the number field has an active validation error, clear the value and stay.
            if (isNumberField && validationErrors.has(index)) {
                handleChange(index, "Valor", null);
                return;
            }

            const posInFocusable = focusableIndices.indexOf(index);
            const isLast = posInFocusable === focusableIndices.length - 1;

            if (isLast) {
                // Last focusable input: keep existing behavior (click hidden test button).
                const testBtn = document.getElementById(`test-btn-${index}`);
                if (testBtn) testBtn.click();
                return;
            }

            // Non-last input: shift focus to the next focusable input.
            const nextIdx = focusableIndices[posInFocusable + 1];
            if (nextIdx !== undefined) {
                inputRefs.current[nextIdx]?.focus();
            }
        },
        [records, focusableIndices, validationErrors, handleChange]
    );
    // 
// ── Photo button click handler ─────────────────────────────────────────
    /**
     * Scenario C – User clicks "Tomar / Cambiar Foto":
     *   Signal Power Apps with OutAction="TAKE_PHOTO" and OutActiveVariable
     *   set to the FK_Variable of this row.  Power Apps opens the camera.
     */
    const handlePhotoClick = useCallback(
        (record: FormRecord) => {
            emitToPowerApps("TAKE_PHOTO", null, record.FK_Variable);
        },
        [emitToPowerApps]
    );
    const handleTestClick = useCallback(
        (record: FormRecord) => {
            const now = Date.now();
            if (now - lastSubmissionTimeRef.current < DEBOUNCE_MS) {
                console.log("[DynamicForm] Submission debounced: too soon after last trigger");
                return;
            }
            lastSubmissionTimeRef.current = now;
            emitToPowerApps("SAVE_AND_NEXT_PLANTACION", null, record.FK_Variable);
        },
        [emitToPowerApps]
    );
    // 
// ── Render one input control based on TipoVariable ─────────────────────
    const renderInput = (record: FormRecord, index: number): React.ReactElement => {
        const hasError = validationErrors.has(index);
        const posInFocusable = focusableIndices.indexOf(index);
        const isLastFocusable = posInFocusable === focusableIndices.length - 1;
        // enterkeyhint tells mobile keyboards what action to show
        // "next" = show "Next" button, "done" / "go" = show "Done" / "Go" button
        const enterKeyHint: "next" | "done" = isLastFocusable ? "done" : "next";
        const commonInputProps = {
            id: `df-input-${index}`,
            className: `df-input${hasError ? " df-input--error" : ""}`,
            enterKeyHint, // HTML5 attribute for mobile keyboard action button
        };
        switch (record.TipoVariable) {
            // 
// ── Integer numeric field ───────────────────────────────────────
            // Uses type="text" to prevent mobile keyboards from adding commas/dots
            // Only digits 0-9 are allowed; all other chars are stripped
            case "Numero entero":
                return (
                    <input
                        {...commonInputProps}
                        type="text"
                        inputMode="numeric"   /* Android/iOS: shows numeric keyboard */
                        pattern="[0-9]*"      /* iOS hint for numeric-only           */
                        placeholder="Ingrese el valor entero"
                        value={record.Valor ?? ""}
                        ref={(el) => { inputRefs.current[index] = el; }}
                        onChange={(e) => {
                            const sanitized = sanitizeInteger(e.target.value);
                            handleChange(index, "Valor", sanitized);
                        }}
                        onKeyDown={(e) => handleKeyDown(e, index)}
                    />
                );
            // 
// ── Decimal numeric field ───────────────────────────────────────
            // Uses type="text" to preserve Spanish comma separator (e.g., "12,5")
            case "Numero decimal":
                return (
                    <input
                        {...commonInputProps}
                        type="text"
                        inputMode="decimal"   /* Shows decimal keyboard on mobile */
                        placeholder="Ingrese el valor decimal"
                        value={record.Valor ?? ""}
                        ref={(el) => { inputRefs.current[index] = el; }}
                        onChange={(e) => {
                            const sanitized = sanitizeDecimal(e.target.value);
                            handleChange(index, "Valor", sanitized);
                        }}
                        onKeyDown={(e) => handleKeyDown(e, index)}
                    />
                );
            // 
// ── Free-text field ─────────────────────────────────────────────
            case "Texto":
                return (
                    <input
                        {...commonInputProps}
                        type="text"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder="Ingrese el valor"
                        value={record.Valor ?? ""}
                        ref={(el) => { inputRefs.current[index] = el; }}
                        onChange={(e) =>
                            handleChange(index, "Valor", e.target.value !== "" ? e.target.value : null)
                        }
                        onKeyDown={(e) => handleKeyDown(e, index)}
                    />
                );
            // 
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
                const buttonText = hasPhoto ? "Cambiar Foto" : "Añadir Foto";
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
                        <span className="df-label-text">{cleanVariableName(record.NombreVariable)}</span>
                    </label>
                    {/* Input control (varies by TipoVariable) ─────────────── */}
                    <div className="df-input-wrapper">
                        {/* Wrap input in form for mobile keyboard submit detection */}
                        <form
                            onSubmit={(e) => handleFormSubmit(e, index)}
                            className="df-input-form"
                            style={{ display: "flex", flexDirection: "row", gap: "8px", alignItems: "center" }}
                        >
                            {renderInput(record, index)}
                            {index === focusableIndices[focusableIndices.length - 1] && (
                                <button
                                    type="button"
                                    id={`test-btn-${index}`}
                                    className="df-photo-button"
                                    onClick={() => handleTestClick(record)}
                                    style={{ display: "none" }}
                                >
                                    Test
                                </button>
                            )}
                        </form>
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