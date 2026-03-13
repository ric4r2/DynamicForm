/**
 * index.ts  –  PCF entry point for DynamicForm  (StandardControl)
 * ─────────────────────────────────────────────────────────────────────────
 * WHY StandardControl (not ReactControl / virtual)?
 *   Virtual controls share the platform's React instance. On Canvas mobile
 *   apps this can interact poorly with the app shell and cause focus/keyboard
 *   issues. StandardControl gives us an isolated DIV container; we mount our
 *   own React tree via ReactDOM.render(), which is fully self-contained and
 *   keeps the mobile virtual keyboard under our control.
 *
 * Data flow:
 *   Power Apps  ──(FormDataJSON, RefValoresCategoricosJSON)──►  updateView()
 *               ◄──(OutAction, OutModifiedRecord, OutActiveVariable)──  getOutputs()
 *
 * The React component (DynamicForm.tsx) calls triggerOutputChange() whenever
 * it wants to signal Power Apps.  That callback stores the values here and
 * calls notifyOutputChanged() so the framework calls getOutputs() next tick.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { IInputs, IOutputs } from "./generated/ManifestTypes";
// Import with alias to avoid conflict with the PCF class also named DynamicForm
import { DynamicFormComponent, IDynamicFormProps, FormRecord } from "./DynamicForm";
import * as React from "react";
import * as ReactDOM from "react-dom";

export class DynamicForm implements ComponentFramework.StandardControl<IInputs, IOutputs> {

    // ── Container injected by the PCF runtime ──────────────────────────────
    // "!" = definite-assignment assertion: the PCF framework guarantees init()
    // is called before updateView() or getOutputs(), so these are never null.
    private _container!: HTMLDivElement;

    // ── Framework callback; calling it tells PCF to invoke getOutputs() ────
    private _notifyOutputChanged!: () => void;

    // ── Pending output values written by the React component ──────────────
    /** Action token to send to Power Apps */
    private _outAction = "";
    /** Serialised single record to send to Power Apps */
    private _outModifiedRecord = "";
    /** FK_Variable for photo rows; undefined when not a photo action */
    private _outActiveVariable: number | undefined = undefined;
    /** Monotonic token used to force Canvas OnChange detection */
    private _outEventTick = 0;

    /**
     * We echo the last raw FormDataJSON back in getOutputs() so the
     * bound-property binding in Power Apps stays stable (no spurious updates).
     */
    private _lastFormDataJSON = "";
    private _eventCounter = 0;

    // ── React component ref – lets us call imperative methods if needed ────
    // (currently unused, but kept for future extensibility)

    constructor() { /* intentionally empty */ }

    // ═════════════════════════════════════════════════════════════════════════
    //  init  – called once when the PCF is first mounted
    // ═════════════════════════════════════════════════════════════════════════
    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this._container = container;
        this._notifyOutputChanged = notifyOutputChanged;

        // The container div may have a default display:block; set box-sizing
        // so the form fills the full width Power Apps allocates.
        this._container.style.cssText = "width:100%;height:100%;overflow-y:auto;box-sizing:border-box;";
        console.log("[DynamicForm PCF] init completed");
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  updateView  – called whenever any bound / input property changes
    // ═════════════════════════════════════════════════════════════════════════
    public updateView(context: ComponentFramework.Context<IInputs>): void {
        const formDataJSON = context.parameters.FormDataJSON.raw ?? "";
        const refValoresJSON = context.parameters.RefValoresCategoricosJSON.raw ?? "";
        const skipNonTextField = context.parameters.skipNonTextField.raw ?? false;
        const inboundOutAction = context.parameters.OutAction.raw ?? "";
        const inboundOutModifiedRecord = context.parameters.OutModifiedRecord.raw ?? "";
        const inboundOutEventTick = context.parameters.OutEventTick.raw ?? 0;

        console.log("[DynamicForm PCF] updateView", {
            formDataLength: formDataJSON.length,
            refValoresLength: refValoresJSON.length,
            skipNonTextField,
            inboundOutAction,
            inboundOutModifiedRecordLength: inboundOutModifiedRecord.length,
            inboundOutEventTick,
        });

        // OutAction / OutModifiedRecord / OutEventTick are bound properties.
        // Canvas may echo these values back through context.parameters on re-render.
        // We intentionally DO NOT copy inbound values into internal output state;
        // only triggerOutputChange() is allowed to mutate outgoing events.

        // Cache for getOutputs() echo
        this._lastFormDataJSON = formDataJSON;

        // Build props for the React component
        const props: IDynamicFormProps = {
            formDataJSON,
            refValoresCategoricosJSON: refValoresJSON,
            skipNonTextField,

            /**
             * triggerOutputChange  –  called by the React component whenever it
             * needs to notify Power Apps of an action.
             *
             * @param action         – One of SAVE_RECORD | SAVE_AND_NEXT_PLANTACION | TAKE_PHOTO
             * @param record         – The modified FormRecord (null for TAKE_PHOTO)
             * @param activeVariable – FK_Variable (null unless action === TAKE_PHOTO)
             */
            triggerOutputChange: (
                action: string,
                record: FormRecord | null,
                activeVariable: number | null
            ): void => {
                this._outAction = action;
                this._outModifiedRecord = record ? JSON.stringify(record) : "";
                this._outActiveVariable = activeVariable ?? undefined;
                this._eventCounter += 1;
                this._outEventTick = this._eventCounter;

                console.log("[DynamicForm PCF] triggerOutputChange", {
                    action: this._outAction,
                    hasRecord: !!record,
                    activeVariable: this._outActiveVariable,
                    outEventTick: this._outEventTick,
                });

                // Signal PCF to call getOutputs() on the next frame
                this._notifyOutputChanged();
            },
        };

        // Mount / re-render the React tree into the isolated container div.
        // React 16's render() is efficient: subsequent calls diff and patch.
        ReactDOM.render(
            React.createElement(DynamicFormComponent, props),
            this._container
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  getOutputs  – called by the PCF runtime after notifyOutputChanged()
    //                Returns the current output values to Power Apps.
    // ═════════════════════════════════════════════════════════════════════════
    public getOutputs(): IOutputs {
        // Capture current output values to return
        const outputs: IOutputs = {
            // Echo the bound property back unchanged (prevents infinite update loop)
            FormDataJSON: this._lastFormDataJSON,

            OutAction: this._outAction,
            OutModifiedRecord: this._outModifiedRecord,
            OutActiveVariable: this._outActiveVariable,
            OutEventTick: this._outEventTick,
        };

        console.log("[DynamicForm PCF] getOutputs", {
            outAction: outputs.OutAction,
            outActiveVariable: outputs.OutActiveVariable,
            outEventTick: outputs.OutEventTick,
            outModifiedRecordLength: outputs.OutModifiedRecord ? outputs.OutModifiedRecord.length : 0,
        });

        return outputs;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  destroy  – clean up when the control is removed from the DOM
    // ═════════════════════════════════════════════════════════════════════════
    public destroy(): void {
        ReactDOM.unmountComponentAtNode(this._container);
    }
}
