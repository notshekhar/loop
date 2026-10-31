/**
 * Anatomy — Ryan's `anatomy` skill (github.com/wheresryan22/anatomy) as a
 * loop extension: it explains an idea by building it as a real, working
 * object — crafted, interactive isometric figures in SVG, WebGL and 3D.
 *
 * Like wayfinder, and unlike ponytail/caveman, it is not a persona: nothing
 * reaches the system prompt. It runs only when the user types /anatomy, which
 * submits the skill as that one turn (the `inject-skill` emit `/skill:<name>`
 * uses). Since it costs nothing until then, it ships enabled.
 */
import type { SlashCommand } from "../../../commands";
import type { ExtensionAPI } from "../../api";
import { extensionDir } from "../../store";
import { buildInvocation } from "./instructions";
import { ensureSkill, isInstalled } from "./source";

/** /anatomy <idea>, keeping its downloaded skill under root. */
export function anatomyCommand(root: () => string): SlashCommand {
    return {
        name: "anatomy",
        description: "Explain an idea as a crafted, interactive isometric figure: /anatomy <idea>",
        handler: async (ctx, args) => {
            if (!isInstalled(root())) ctx.emit("help", "anatomy: downloading the skill (about 27 MB, once)…");
            let dir: string;
            try {
                dir = await ensureSkill(root());
            } catch (err) {
                ctx.emit("error", `anatomy: could not download the skill: ${(err as Error).message}`);
                return;
            }
            ctx.emit("inject-skill", buildInvocation(dir, args.trim()));
        },
    };
}

export default {
    activate(api: ExtensionAPI) {
        const root = () => extensionDir("anatomy");
        api.extension.setStatus(() => (isInstalled(root()) ? "ready" : "downloads on first use"));
        api.commands.register(anatomyCommand(root));
    },
};
