import { describe, it } from "vitest";
import fs from "node:fs";
import { buildNote, selectWholeNote } from "./driver.js";

describe("single note", () => {
    it("runs", async () => {
        const f = process.env.ONE_FILE;
        const raw = fs.readFileSync(f, "utf8");
        fs.writeFileSync(process.env.DIAG_OUT, "stage=read chars=" + raw.length);
        const note = await buildNote(raw, "x.md");
        fs.writeFileSync(process.env.DIAG_OUT, "stage=built blocks=" + note.rendered.length);
        const t0 = Date.now();
        const res = await selectWholeNote(note);
        fs.writeFileSync(
            process.env.DIAG_OUT,
            `blocks=${note.rendered.length} chars=${raw.length} ms=${Date.now() - t0} changed=${res.changed} failed=${res.failed}`
        );
    });
});
