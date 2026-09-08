const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
require("dotenv").config();
app.use(express.json());
const FILE_API_KEY = process.env.FILE_API_KEY;

if (!FILE_API_KEY) {
    console.error(
        "ERROR: FILE_API_KEY is not configured in .env"
    );

    process.exit(1);
}
const PORT = process.env.PORT;

// Base upload directory
const UPLOAD_DIR = process.env.UPLOAD_FOLDER_PATH;

// Allowed folders
const ALLOWED_FOLDERS = [
    "normal",
    "express",
    "cash"
];

const ALLOWED_ORIGINS = [
    process.env.ORIGIN
];

app.use(
    cors({
        origin: function (origin, callback) {

            // Allow requests with no Origin header
            // such as curl, Postman, Node.js downloader, etc.
            if (!origin) {
                return callback(null, true);
            }

            if (ALLOWED_ORIGINS.includes(origin)) {
                return callback(null, true);
            }

            console.log(
                "Blocked CORS origin:",
                origin
            );

            return callback(
                new Error("Origin not allowed")
            );
        },

        methods: [
            "GET",
            "POST",
            "OPTIONS"
        ],

        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ]
    })
);

// Create folders
for (const folder of ALLOWED_FOLDERS) {
    const folderPath = path.join(UPLOAD_DIR, folder);

    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, {
            recursive: true
        });
    }
}

/*
|--------------------------------------------------------------------------
| Multer configuration
|--------------------------------------------------------------------------
*/

const storage = multer.diskStorage({

    destination: (req, file, cb) => {

        const folder = req.body.folder;

        if (!ALLOWED_FOLDERS.includes(folder)) {
            return cb(
                new Error("Invalid folder")
            );
        }

        cb(
            null,
            path.join(UPLOAD_DIR, folder)
        );
    },

    filename: (req, file, cb) => {

        const ext = path.extname(
            file.originalname
        );

        const uniqueName =
            Date.now() +
            "-" +
            crypto
                .randomBytes(6)
                .toString("hex") +
            ext;

        cb(null, uniqueName);
    }
});

const upload = multer({
    storage
});

/*
|--------------------------------------------------------------------------
| File API authentication
|--------------------------------------------------------------------------
*/

function authenticateFileAPI(req, res, next) {

    const providedKey =
        req.get("X-API-Key");

    if (!providedKey) {

        return res.status(401).json({
            success: false,
            message: "API key required"
        });
    }

    /*
    |--------------------------------------------------------------------------
    | Timing-safe comparison
    |--------------------------------------------------------------------------
    */

    const providedBuffer =
        Buffer.from(providedKey);

    const expectedBuffer =
        Buffer.from(FILE_API_KEY);

    if (
        providedBuffer.length !==
        expectedBuffer.length
    ) {

        return res.status(401).json({
            success: false,
            message: "Invalid API key"
        });
    }

    if (
        !crypto.timingSafeEqual(
            providedBuffer,
            expectedBuffer
        )
    ) {

        return res.status(401).json({
            success: false,
            message: "Invalid API key"
        });
    }

    next();
}

/*
|--------------------------------------------------------------------------
| Upload file
|--------------------------------------------------------------------------
|
| POST /api/files/upload
|
| Form-data:
|
| file   = file
| folder = normal / express / cash
|
|--------------------------------------------------------------------------
*/

app.post(
    "/api/files/upload",
    authenticateFileAPI,
    upload.single("file"),
    (req, res) => {

        if (!req.file) {

            return res.status(400).json({
                success: false,
                message: "No file uploaded"
            });
        }

        const folder = req.body.folder;

        console.log(
            `New file received: ${folder}/${req.file.filename}`
        );

        res.status(201).json({

            success: true,

            file: {
                name: req.file.filename,
                originalName: req.file.originalname,
                folder: folder,
                size: req.file.size
            }
        });
    }
);


/*
|--------------------------------------------------------------------------
| Find next available file
|--------------------------------------------------------------------------
|
| GET /api/files/next
|
|--------------------------------------------------------------------------
*/

app.get(
    "/api/files/next",
    authenticateFileAPI,
    (req, res) => {

        let allFiles = [];

        for (const folder of ALLOWED_FOLDERS) {

            const folderPath =
                path.join(
                    UPLOAD_DIR,
                    folder
                );

            let files;

            try {

                files = fs.readdirSync(
                    folderPath
                );

            } catch (error) {

                console.error(
                    `Cannot read ${folder}:`,
                    error.message
                );

                continue;
            }

            for (const filename of files) {

                const filePath =
                    path.join(
                        folderPath,
                        filename
                    );

                try {

                    const stat =
                        fs.statSync(filePath);

                    if (!stat.isFile()) {
                        continue;
                    }

                    allFiles.push({

                        folder,

                        name: filename,

                        size: stat.size,

                        createdAt:
                            stat.birthtimeMs,

                        downloadUrl:
                            `/api/files/download/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`
                    });

                } catch {
                    // Ignore invalid files
                }
            }
        }

        /*
        |--------------------------------------------------------------------------
        | No files
        |--------------------------------------------------------------------------
        */

        if (allFiles.length === 0) {

            return res.status(204).end();
        }

        /*
        |--------------------------------------------------------------------------
        | Oldest file first
        |--------------------------------------------------------------------------
        */

        allFiles.sort(
            (a, b) =>
                a.createdAt - b.createdAt
        );

        const file = allFiles[0];

        res.json({

            success: true,

            file

        });
    }
);


/*
|--------------------------------------------------------------------------
| Download file
|--------------------------------------------------------------------------
|
| GET
| /api/files/download/:folder/:filename
|
|--------------------------------------------------------------------------
*/

app.get(
    "/api/files/download/:folder/:filename",
    authenticateFileAPI,
    (req, res) => {

        const folder =
            req.params.folder;

        const filename =
            req.params.filename;

        /*
        |--------------------------------------------------------------------------
        | Validate folder
        |--------------------------------------------------------------------------
        */

        if (
            !ALLOWED_FOLDERS.includes(
                folder
            )
        ) {

            return res.status(400).json({
                success: false,
                message: "Invalid folder"
            });
        }

        /*
        |--------------------------------------------------------------------------
        | Prevent path traversal
        |--------------------------------------------------------------------------
        */

        const safeFilename =
            path.basename(filename);

        const filePath =
            path.join(
                UPLOAD_DIR,
                folder,
                safeFilename
            );

        /*
        |--------------------------------------------------------------------------
        | Check file
        |--------------------------------------------------------------------------
        */

        if (!fs.existsSync(filePath)) {

            return res.status(404).json({
                success: false,
                message: "File not found"
            });
        }

        /*
        |--------------------------------------------------------------------------
        | Download
        |--------------------------------------------------------------------------
        */

        res.download(
            filePath,
            safeFilename,
            error => {

                if (error) {

                    console.error(
                        "Download error:",
                        error.message
                    );
                }
            }
        );
    }
);


/*
|--------------------------------------------------------------------------
| ACK successful download
|--------------------------------------------------------------------------
|
| POST /api/files/ack
|
| {
|   "folder": "normal",
|   "filename": "abc.pdf"
| }
|
|--------------------------------------------------------------------------
*/

app.post(
    "/api/files/ack",
    authenticateFileAPI,
    (req, res) => {

        const {
            folder,
            filename
        } = req.body;

        /*
        |--------------------------------------------------------------------------
        | Validate
        |--------------------------------------------------------------------------
        */

        if (
            !folder ||
            !filename
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "folder and filename are required"
            });
        }

        if (
            !ALLOWED_FOLDERS.includes(
                folder
            )
        ) {

            return res.status(400).json({
                success: false,
                message: "Invalid folder"
            });
        }

        /*
        |--------------------------------------------------------------------------
        | Safe filename
        |--------------------------------------------------------------------------
        */

        const safeFilename =
            path.basename(filename);

        const filePath =
            path.join(
                UPLOAD_DIR,
                folder,
                safeFilename
            );

        /*
        |--------------------------------------------------------------------------
        | Check file
        |--------------------------------------------------------------------------
        */

        if (!fs.existsSync(filePath)) {

            return res.status(404).json({
                success: false,
                message:
                    "File already deleted or does not exist"
            });
        }

        /*
        |--------------------------------------------------------------------------
        | Delete
        |--------------------------------------------------------------------------
        */

        fs.unlink(
            filePath,
            error => {

                if (error) {

                    console.error(
                        "Delete error:",
                        error.message
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Could not delete file"
                    });
                }

                console.log(
                    `Deleted: ${folder}/${safeFilename}`
                );

                res.json({

                    success: true,

                    message:
                        "File deleted successfully"

                });
            }
        );
    }
);


/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get(
    "/",
    (req, res) => {

        res.json({
            success: true,
            message:
                "File server running"
        });
    }
);


/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

app.listen(
    PORT,
    () => {

        console.log(
            `File server running on port ${PORT}`
        );

        console.log(
            `Upload directory: ${UPLOAD_DIR}`
        );
    }
);
