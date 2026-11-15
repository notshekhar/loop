import type { ProviderInstanceId, ResolvedKeybindingsConfig } from "@loop/contracts";
import { useEffect, useMemo } from "react";
import { modelPickerModelKey, parseModelPickerModelKey } from "../modelPickerKeys";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../../keybindings";
import type { ModelPickerItem } from "./modelPickerItems";

type ModelJumpCommand = NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>;
type ModelJumpShortcutContext = {
  readonly terminalFocus: false;
  readonly terminalOpen: boolean;
  readonly modelPickerOpen: true;
};

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();

interface ModelPickerJumpShortcutsInput {
  visibleModels: ModelPickerItem[];
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  getModelDisabledReason:
    | ((instanceId: ProviderInstanceId, model: string) => string | null)
    | undefined;
  onSelectModel: (modelSlug: string, instanceId: ProviderInstanceId) => void;
}

/** Numbers the selectable (not disabled) visible models with jump commands, in order. */
function useModelJumpCommands(input: ModelPickerJumpShortcutsInput) {
  const { getModelDisabledReason, visibleModels } = input;
  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, ModelJumpCommand>();
    let selectableModelIndex = 0;
    for (const model of visibleModels) {
      if (getModelDisabledReason?.(model.instanceId, model.slug)) {
        continue;
      }
      const jumpCommand = modelPickerJumpCommandForIndex(selectableModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(modelPickerModelKey(model.instanceId, model.slug), jumpCommand);
      selectableModelIndex += 1;
    }
    return mapping;
  }, [getModelDisabledReason, visibleModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  return { modelJumpCommandByKey, modelJumpModelKeys };
}

function useModelJumpLabels(
  keybindings: ResolvedKeybindingsConfig,
  modelJumpCommandByKey: ReadonlyMap<string, ModelJumpCommand>,
  modelJumpShortcutContext: ModelJumpShortcutContext,
): ReadonlyMap<string, string> {
  return useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);
}

function useModelJumpKeydown(
  keybindings: ResolvedKeybindingsConfig,
  modelJumpModelKeys: ReadonlyArray<string>,
  modelJumpShortcutContext: ModelJumpShortcutContext,
  handleModelSelect: (modelSlug: string, instanceId: ProviderInstanceId) => void,
): void {
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const model = parseModelPickerModelKey(targetModelKey);
      if (!model) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleModelSelect(model.slug, model.instanceId);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [handleModelSelect, keybindings, modelJumpModelKeys, modelJumpShortcutContext]);
}

/** Numbered jump shortcuts for the visible models: their labels, and the window key handler. */
export function useModelPickerJumpShortcuts(
  input: ModelPickerJumpShortcutsInput,
): ReadonlyMap<string, string> {
  const { keybindings, terminalOpen } = input;
  const { modelJumpCommandByKey, modelJumpModelKeys } = useModelJumpCommands(input);
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [terminalOpen],
  );
  const modelJumpLabelByKey = useModelJumpLabels(
    keybindings,
    modelJumpCommandByKey,
    modelJumpShortcutContext,
  );
  useModelJumpKeydown(
    keybindings,
    modelJumpModelKeys,
    modelJumpShortcutContext,
    input.onSelectModel,
  );
  return modelJumpLabelByKey;
}
