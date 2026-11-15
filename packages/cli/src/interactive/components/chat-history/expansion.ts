import type { AssistantMessageComponent, SkillInvocationMessageComponent } from "../../ui/messages";
import type { ToolExecutionComponent } from "../../ui/tool-execution";

/** A summary block that rides the expand-all toggle (compaction, branch). */
interface ExpandableSummary {
    setExpanded(expanded: boolean): void;
}

/**
 * The global expand-all state and every component it reaches: tool calls,
 * skill invocations, summaries, and the thinking inside assistant messages.
 * A component registered here starts in the current state.
 */
export class ExpandAll {
    private expanded = false;
    private tools: ToolExecutionComponent[] = [];
    private skills: SkillInvocationMessageComponent[] = [];
    private summaries: ExpandableSummary[] = [];
    private assistants: AssistantMessageComponent[] = [];

    isExpanded(): boolean {
        return this.expanded;
    }

    set(expanded: boolean): void {
        this.expanded = expanded;
        for (const c of this.tools) c.setExpanded(expanded);
        for (const c of this.skills) c.setExpanded(expanded);
        for (const c of this.summaries) c.setExpanded(expanded);
        for (const c of this.assistants) c.setThinkingExpanded(expanded);
    }

    trackTool(comp: ToolExecutionComponent): void {
        if (this.expanded) comp.setExpanded(true);
        this.tools.push(comp);
    }

    trackSkill(comp: SkillInvocationMessageComponent): void {
        comp.setExpanded(this.expanded);
        this.skills.push(comp);
    }

    trackSummary(comp: ExpandableSummary): void {
        comp.setExpanded(this.expanded);
        this.summaries.push(comp);
    }

    trackAssistant(comp: AssistantMessageComponent): void {
        comp.setThinkingExpanded(this.expanded);
        this.assistants.push(comp);
    }

    /** Fold every assistant message's blocks back to their default. */
    resetAssistantFolds(): void {
        for (const c of this.assistants) c.resetFolds();
    }

    /** Forget every component (the transcript is cleared); the state stays. */
    clear(): void {
        this.tools = [];
        this.skills = [];
        this.summaries = [];
        this.assistants = [];
    }
}
