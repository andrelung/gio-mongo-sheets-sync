import { MongoClient } from "mongodb";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import cron from "node-cron";

import dotenv from "dotenv";
dotenv.config({ path: ".env" });

// Load your MongoDB and Google Sheet configurations from environment variables
const MONGO_URI = process.env.MONGO_URI || "please define in .env";
const DB_NAME = process.env.MONGO_COLLECTION_NAME || "please define in .env";
const FILE_ID = process.env.GOOGLE_FILE_ID || "please define in .env";
const TAB_TITLE = process.env.GOOGLE_TAB_TITLE || "booked_hours_per_person";
// const TAB_ID = process.env.SHEET_ID || 0;

async function fetchDataAndUpdateSheet() {
    console.log(
        "Starting data fetch and Google Sheet update at " +
            new Date().toISOString()
    );
    let client;
    try {
        // Retry counter
        const MAX_RETRIES = 3;
        let attempt = 0;

        // Retry logic for connecting to MongoDB
        while (attempt < MAX_RETRIES) {
            try {
                // MongoClient constructor accepts uri directly; options left empty for now
                client = new MongoClient(MONGO_URI);
                await client.connect();
                console.log("Connected to MongoDB");
                break;
            } catch (err) {
                attempt++;
                const msg = err instanceof Error ? err.message : String(err);
                console.error(
                    `MongoDB connection attempt ${attempt} failed:`,
                    msg
                );
                if (attempt >= MAX_RETRIES) throw err; // Rethrow error after max retries
            }
        }

        const db = client!.db(DB_NAME);
        const collection = db.collection("tasks");

        // Define the aggregation pipeline and carry project_main_name
        const pipeline = [
            {
                $group: {
                    _id: {
                        project: "$project_main_gid",
                        project_main_name: "$project_main_name",
                        assignee: {
                            $ifNull: ["$assignee_mail", "<unassigned>"],
                        },
                    },
                    total_hours: { $sum: "$hours_completed_self" },
                },
            },
            {
                $group: {
                    _id: "$_id.project",
                    project_main_name: { $first: "$_id.project_main_name" },
                    hours_per_assignee: {
                        $push: {
                            assignee: "$_id.assignee",
                            total_hours: "$total_hours",
                        },
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    project_gid: "$_id",
                    project_main_name: "$project_main_name",
                    hours: {
                        $arrayToObject: {
                            $map: {
                                input: "$hours_per_assignee",
                                as: "entry",
                                in: {
                                    k: { $toString: "$$entry.assignee" },
                                    v: "$$entry.total_hours",
                                },
                            },
                        },
                    },
                },
            },
        ];

        // Execute the aggregation
        const results = await collection.aggregate(pipeline).toArray();
        if (!results || results.length === 0) {
            throw new Error("No data found or aggregation error.");
        }

        // Initialize Google Sheet
        const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY || "";
        const privateKey = privateKeyRaw.includes("\\n")
            ? privateKeyRaw.replace(/\\n/g, "\n")
            : privateKeyRaw;

        const serviceAccountAuth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: privateKey,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });

        const doc = new GoogleSpreadsheet(FILE_ID, serviceAccountAuth);

        await doc.loadInfo(); // loads document properties and worksheets
        console.log("______");
        console.log("using:                     " + doc.title);

        // const sheet = doc.sheetsByIndex[0]; // or use `doc.sheetsById[id]` or `doc.sheetsByTitle[title]`
        // const sheet = doc.sheetsById[TAB_ID]; // or use `doc.sheetsById[id]` or `doc.sheetsByTitle[title]`
        const sheet = doc.sheetsByTitle[TAB_TITLE];
        // debugger;

        console.log("with sheet:                " + sheet.title);
        console.log("and current rowCount:      " + sheet.rowCount);
        console.log("and current columnCount:   " + sheet.columnCount);

        // Clear existing data
        await sheet.clear();

        // Helper to format project ids so Sheets treats them as text (avoid scientific notation)
        const formatProjectId = (id: unknown) => {
            if (id === null || id === undefined) return "";
            const s = String(id);
            // If it's all digits (likely a numeric id) or ends with 0, prefix with apostrophe to force text
            if (/^\d+$/.test(s) || s.endsWith("0")) {
                return s.startsWith("'") ? s : `'${s}`;
            }
            return s;
        };

        // Validate the rows before adding and normalize headers across all rows
        const rows = results.map((result) => ({
            project_gid: formatProjectId(result.project_gid),
            project_main_name: result.project_main_name || "",
            ...result.hours,
        }));
        if (rows.length === 0) {
            throw new Error("No valid rows to update.");
        }

        // Build a stable header row using the union of all keys across results.
        // This ensures every row has the same set of columns when written to Google Sheets.
        const keySet = new Set<string>();
        rows.forEach((r) => Object.keys(r).forEach((k) => keySet.add(k)));

        // Ensure `project_gid` & `project_main_name` are the first columns.
        // Sort other keys (assignee/email columns) alphabetically (case-insensitive).
        const otherKeys = Array.from(keySet).filter(
            (k) => k !== "project_gid" && k !== "project_main_name"
        );
        otherKeys.sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base" })
        );
        const headers = ["project_gid", "project_main_name", ...otherKeys];

        // Normalize rows so each row has all header keys (fill missing hours with 0)
        const normalizedRows = rows.map((r) => {
            const nr: Record<string, any> = {};
            for (const h of headers) {
                if (Object.prototype.hasOwnProperty.call(r, h)) {
                    nr[h] = r[h];
                } else {
                    // If it's the project id leave as empty string, otherwise assume numeric hours and set 0
                    nr[h] = h === "project_gid" ? "" : 0;
                }
            }
            return nr;
        });

        // Sort rows by ascending project_gid (numeric-aware). project_gid may be prefixed with '\'' to force text in Sheets;
        // strip that before numeric comparison.
        normalizedRows.sort((a, b) => {
            const aRaw = String(a.project_gid ?? "").replace(/^'/, "");
            const bRaw = String(b.project_gid ?? "").replace(/^'/, "");
            // Try numeric comparison using BigInt when possible
            if (/^\d+$/.test(aRaw) && /^\d+$/.test(bRaw)) {
                try {
                    const aBig = BigInt(aRaw);
                    const bBig = BigInt(bRaw);
                    if (aBig < bBig) return -1;
                    if (aBig > bBig) return 1;
                    return 0;
                } catch (e) {
                    // fallthrough to string compare
                }
            }
            return aRaw.localeCompare(bRaw, undefined, { numeric: true });
        });

        // Update Google Sheet with new data using consistent headers
        const DRY_RUN = (process.env.DRY_RUN || "").toLowerCase();
        if (DRY_RUN === "1" || DRY_RUN === "true" || DRY_RUN === "yes") {
            console.log("DRY_RUN enabled - not writing to Google Sheets.");
            console.log("Headers:", headers);
            console.log("Sample rows (up to 10):", normalizedRows.slice(0, 10));
        } else {
            // Ensure sheet has enough columns to fit all headers. google-spreadsheet exposes
            // different property names across versions, so be defensive.
            const currentColCount =
                // prefer explicit property
                (sheet.columnCount as number) ||
                // fallback name used in some versions (use any to avoid TS errors)
                ((sheet as any).colCount as number) ||
                // if headerValues are present, length can be used
                (Array.isArray((sheet as any).headerValues)
                    ? (sheet as any).headerValues.length
                    : 0) ||
                0;

            if (headers.length > currentColCount) {
                const desiredCols = headers.length;
                console.log(
                    `Sheet has ${currentColCount} columns but needs ${desiredCols} — resizing...`
                );
                // Use the worksheet resize API. Different versions expect {rowCount, colCount}.
                try {
                    // keep the same rowCount, change column count
                    await sheet.resize({
                        rowCount: sheet.rowCount,
                        columnCount: desiredCols,
                    });
                    console.log(`Resized sheet to ${desiredCols} columns`);
                } catch (resizeErr) {
                    console.error("Failed to resize sheet:", resizeErr);
                    throw resizeErr;
                }
            }

            await sheet.setHeaderRow(headers);

            // Add rows in batches to reduce chance of partial failures for large datasets
            const BATCH_SIZE = 500; // adjust if needed
            for (let i = 0; i < normalizedRows.length; i += BATCH_SIZE) {
                const batch = normalizedRows.slice(i, i + BATCH_SIZE);
                await sheet.addRows(batch);
            }
        }

        console.log("Google Sheet updated successfully");

        // ---------- Summary sheet: aggregate by mail domain categories ----------
        // Compute per-project sums for internal / unassigned / external
        const summaryRows = normalizedRows.map((r) => {
            const project_gid = r.project_gid;
            const project_main_name = r.project_main_name || "";
            let internal = 0;
            let unassigned = 0;
            let external = 0;

            for (const key of Object.keys(r)) {
                if (key === "project_gid") continue;
                const raw = String(r[key] ?? "");
                const val = Number(raw) || 0;
                const k = key.toLowerCase().trim();

                // Treat various variants as unassigned
                if (
                    k === "no assignee" ||
                    k === "no assignee>" ||
                    k === "<unassigned>" ||
                    k === "<unassigned" ||
                    k === "" ||
                    k.includes("no assignee")
                ) {
                    unassigned += val;
                    continue;
                }

                // Internal domains
                if (
                    k.endsWith("@grips.io") ||
                    k.endsWith("@retired.grips.io")
                ) {
                    internal += val;
                    continue;
                }

                // Everything else is external
                external += val;
            }

            return {
                project_gid,
                project_main_name,
                internal,
                unassigned,
                external,
                total_hours: internal + unassigned + external,
            };
        });

        // Write summary to sheet named 'Summary'
        const SUMMARY_TITLE = "Summary";
        const summarySheet = doc.sheetsByTitle[SUMMARY_TITLE];
        const summaryHeaders = [
            "project_gid",
            "project_main_name",
            "internal",
            "external",
            "unassigned",
            "total_hours",
        ];

        if (DRY_RUN === "1" || DRY_RUN === "true" || DRY_RUN === "yes") {
            console.log("DRY_RUN: Summary headers:", summaryHeaders);
            console.log("DRY_RUN: Summary sample:", summaryRows.slice(0, 10));
        } else {
            let ss = summarySheet;
            if (!ss) {
                console.log(
                    "Summary sheet not found — creating new sheet 'Summary'"
                );
                // create a new sheet with some default size
                ss = await doc.addSheet({
                    title: SUMMARY_TITLE,
                    // rowCount: Math.max(10, summaryRows.length + 5),
                    // columnCount: summaryHeaders.length,
                } as any);
            }

            // Ensure enough columns
            const curCols =
                (ss.columnCount as number) ||
                ((ss as any).colCount as number) ||
                (Array.isArray((ss as any).headerValues)
                    ? (ss as any).headerValues.length
                    : 0) ||
                0;
            if (summaryHeaders.length > curCols) {
                try {
                    await ss.resize({
                        rowCount: ss.rowCount,
                        columnCount: summaryHeaders.length,
                    });
                    console.log(
                        `Resized 'Summary' to ${summaryHeaders.length} columns`
                    );
                } catch (err) {
                    console.error("Failed to resize 'Summary' sheet:", err);
                    throw err;
                }
            }

            // clear old summary contents then write
            await ss.clear();
            await ss.setHeaderRow(summaryHeaders);
            // add rows in batches
            const BATCH_SIZE_SUM = 500;
            // Ensure summaryRows follow the same ordering as normalizedRows (which are sorted by gid)
            const gidOrder = new Map(
                normalizedRows.map((r, idx) => [String(r.project_gid), idx])
            );
            summaryRows.sort((a, b) => {
                const ai = gidOrder.has(String(a.project_gid))
                    ? gidOrder.get(String(a.project_gid))!
                    : Number.MAX_SAFE_INTEGER;
                const bi = gidOrder.has(String(b.project_gid))
                    ? gidOrder.get(String(b.project_gid))!
                    : Number.MAX_SAFE_INTEGER;
                return ai - bi;
            });
            for (let i = 0; i < summaryRows.length; i += BATCH_SIZE_SUM) {
                const batch = summaryRows.slice(i, i + BATCH_SIZE_SUM);
                await ss.addRows(batch);
            }
            console.log("Summary sheet updated successfully");
        }
    } catch (error) {
        // console.log(error?.message);
        console.error("Error occurred:", error);
        // Optionally: Send alert/notification via email or integration
    } finally {
        // Ensure MongoDB connection is cleaned up
        if (client) {
            await client.close();
            console.log("MongoDB connection closed");
        }
    }
}

// Schedule to run the task daily
cron.schedule("0 17 * * *", fetchDataAndUpdateSheet); // executes at 5pm server time (mostly +00:00)

console.log("Scheduler cron setup complete.");
console.log("Starting first run on App-Start:");
fetchDataAndUpdateSheet();

// TODO: move jovs to separate module, to allow for other jobs in future
// TODO: implement webserver to display last sync (for health checks)
// TODO: implement notifications
