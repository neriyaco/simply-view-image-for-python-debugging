import * as vscode from "vscode";
import Container from "typedi";
import { DebugProtocol } from "vscode-debugprotocol";
import { logDebug, logTrace } from "../Logging";
import { activeDebugSessionData } from "./DebugSessionsHolder";
import { debounce } from "../utils/Utils";
import { WatchTreeProvider } from "../image-watch-tree/WatchTreeProvider";
import { saveAllTrackedObjects } from "../image-watch-tree/TrackedPythonObjects";
import { getConfiguration } from "../config";
import { patchDebugVariableContext } from "./DebugRelatedCommands";
import { runSetup } from "../python-communication/Setup";

// register watcher for the debugging session. used to identify the running-frame,
// so multi-thread will work
// inspired from https://github.com/microsoft/vscode/issues/30810#issuecomment-590099482
export const createDebugAdapterTracker = (
    session: vscode.DebugSession
): vscode.DebugAdapterTracker => {
    type Request<T> = T & { type: "request" };
    type Response<T> = T & { type: "response" };
    type WithEvent<T, Event> = T & { type: "event"; event: Event };
    type WithCommand<T, Command> = T & { command: Command };
    type RecvMsg =
        | WithCommand<Request<DebugProtocol.ScopesRequest>, "scopes">
        | WithCommand<Request<DebugProtocol.VariablesRequest>, "variables">
        | WithCommand<Request<DebugProtocol.EvaluateRequest>, "evaluate">;

    type SendMsg =
        | WithEvent<DebugProtocol.StoppedEvent, "stopped">
        | WithEvent<DebugProtocol.ContinuedEvent, "continued">
        | WithCommand<Response<DebugProtocol.VariablesResponse>, "variables">
        | WithCommand<Response<DebugProtocol.ScopesResponse>, "scopes">;

    const debugSessionData = activeDebugSessionData(session);
    const debugVariablesTracker = debugSessionData.debugVariablesTracker;

    const watchTreeProvider = Container.get(WatchTreeProvider);
    const currentPythonObjectsList = debugSessionData.currentPythonObjectsList;
    const trackedPythonObjects = debugSessionData.trackedPythonObjects;

    const updateWatchTree = async () => {
        await currentPythonObjectsList.update();
        watchTreeProvider.refresh();
    };

    const saveTracked = () => {
        return saveAllTrackedObjects(trackedPythonObjects.allTracked, session);
    };

    const onScopeChange = debounce(async () => {
        await updateWatchTree();
        await saveTracked();
    }, 500);

    return {
        onWillStartSession: () => {
            logTrace("onWillStartSession");
        },

        onWillStopSession: async () => {
            logTrace("onWillStopSession");
            currentPythonObjectsList.clear();
            trackedPythonObjects.clear();
            watchTreeProvider.refresh();
        },

        onWillReceiveMessage: async (msg: RecvMsg) => {
            logTrace("onWillReceiveMessage", msg);
            if (msg.type === "request" && msg.command === "scopes") {
                debugVariablesTracker.onScopesRequest(msg);
            } else if (msg.type === "request" && msg.command === "variables") {
                return debugVariablesTracker.onVariablesRequest(msg);
            } else if (
                msg.type === "request" &&
                msg.command === "evaluate" &&
                /^\s*$/.test(msg.arguments.expression)
            ) {
                // this is our call, in "update-frame-id" command.
                return debugVariablesTracker.setFrameId(msg.arguments.frameId);
            }
        },

        onDidSendMessage: async (msg: SendMsg) => {
            logTrace("onDidSendMessage", msg);

            // breakpoint hit
            if (
                msg.type === "event" &&
                msg.event === "stopped" &&
                msg.body.threadId !== undefined
            ) {
                logDebug("Breakpoint hit");

                await debounce(runSetup, 250)(session);
            } else if (msg.type === "response" && msg.command === "variables") {
                // Add context to debug variable. This is a workaround.
                if (
                    getConfiguration(
                        "addViewContextEntryToVSCodeDebugVariables"
                    ) === true
                ) {
                    patchDebugVariableContext(msg);
                }
                debugVariablesTracker.onVariablesResponse(msg);
                return updateWatchTree();
            } else if (msg.type === "event" && msg.event === "continued") {
                return debugVariablesTracker.onContinued();
            } else if (msg.type === "response" && msg.command === "scopes") {
                debugVariablesTracker.onScopesResponse(msg);
                // scope has changed. Make setup is okay
                await runSetup(session);
                await onScopeChange();
            }
        },

        onError: (error: Error) => {
            logTrace("onError", error);
        },

        onExit: () => {
            // same as onWillStopSession
            logTrace("onExit");
            currentPythonObjectsList.clear();
            trackedPythonObjects.clear();
            watchTreeProvider.refresh();
        },
    };
};
