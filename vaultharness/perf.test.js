import { describe, it } from "vitest";
import fs from "node:fs";
import { buildNote, selectWholeNote } from "./driver.js";

describe("whole-article timing", () => {
    it("times the biggest notes", async () => {
        const OUT = [];
        for (const f of JSON.parse(process.env.PERF_FILES)) {
            const raw = fs.readFileSync(f, "utf8");
            const note = await buildNote(raw, "x.md");
            const t0 = Date.now();
            const res = await selectWholeNote(note);
            OUT.push(
                `${String(Date.now() - t0).padStart(7)}ms  blocks=${String(note.rendered.length).padStart(4)}  chars=${String(raw.length).padStart(6)}  changed=${res.changed}  ${f.split("/").pop().slice(0, 40)}`
            );
        }
        fs.writeFileSync(process.env.DIAG_OUT, OUT.join("\n"));
    });
});
