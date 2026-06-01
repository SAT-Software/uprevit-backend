import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const INPUT_FILE_TO_VIDEO_KEY = {
	"departments-tab.mp4": "department.departments-tab",
	"welcome-dashboard.mp4": "getting-started.welcome-dashboard",
	"compare-versions-redline-view.mp4": "product.compare-versions-redline-view",
	"compliance-tab.mp4": "product.compliance-tab",
	"label-components.mp4": "product.label-components",
	"label-tags.mp4": "product.label-tags",
	"product-information.mp4": "product.product-information",
	"product-plan-review-overview.mp4": "product.product-plan-review-overview",
	"product-specifications.mp4": "product.product-specifications",
	"products-intro.mp4": "product.products-intro",
	"symbols-graphics.mp4": "product.symbols-graphics",
	"projects-tab.mp4": "projects.projects-tab",
	"overview.mp4": "reports-analytics.overview",
	"source-files-archive-bookmarks.mp4": "working-with-files.source-files-archive-bookmarks",
	"Department/Departments Tab.mp4": "department.departments-tab",
	"Workspace/Welcome Dashboard Video.mp4": "getting-started.welcome-dashboard",
	"Product/Compliance Tab.mp4": "product.compliance-tab",
	"Product/Label Components-V2.mp4": "product.label-components",
	"Product/Label Tags Tab-V2.mp4": "product.label-tags",
	"Product/Product Information tab.mp4": "product.product-information",
	"Product/Product Plan review Overview.mp4": "product.product-plan-review-overview",
	"Product/Product Specification tab.mp4": "product.product-specifications",
	"Product/Products_tab_Intro v2.mp4": "product.products-intro",
	"Product/Symbol & graphics.mp4": "product.symbols-graphics",
	"Projects/Projects_Tab-V2.mp4": "projects.projects-tab",
	"Reports & Analystics/Reports & Analytics.mp4": "reports-analytics.overview",
	"Source Files, Archive, Bookmark/Source File-Archive-Bookmarks Tab.mp4":
		"working-with-files.source-files-archive-bookmarks",
};

const usage = [
	"Usage:",
	"  npm run seed:documentation-videos -- [--input-dir ./documentation-videos-input] [--bucket uprevit-documentation-files] [--dry-run]",
	"  npm run seed:documentation-videos -- --scan-dir",
	"  npm run seed:documentation-videos -- --generate-allowlist",
	"",
	"Run from uprevit-backend/src after: npm install",
	"Required env for upload: AWS_REGION (+ AWS credentials with s3:PutObject)",
	"Optional env: DOCUMENTATION_FILES_BUCKET",
].join("\n");

const parseArgs = () => {
	const argv = process.argv.slice(2);
	const getValue = (name) => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv[index + 1] : undefined;
	};

	const defaultInputDir = path.join(scriptDir, "documentation-videos-input");

	return {
		inputDir: path.resolve(getValue("--input-dir") ?? defaultInputDir),
		bucket:
			getValue("--bucket") ||
			process.env.DOCUMENTATION_FILES_BUCKET ||
			"uprevit-documentation-files",
		dryRun: argv.includes("--dry-run"),
		scanOnly: argv.includes("--scan-dir"),
		generateAllowlist: argv.includes("--generate-allowlist"),
	};
};

const listMp4Files = async (dir, prefix = "") => {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;

		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			files.push(...(await listMp4Files(path.join(dir, entry.name), relativePath)));
			continue;
		}

		if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
			files.push(relativePath);
		}
	}

	return files;
};

const resolveVideoKey = (relativePath) => {
	const normalized = relativePath.split(path.sep).join("/");
	return INPUT_FILE_TO_VIDEO_KEY[normalized] ?? null;
};

const objectKeyForVideoKey = (videoKey) => {
	const dotIndex = videoKey.indexOf(".");
	if (dotIndex <= 0) {
		throw new Error(`Invalid videoKey (expected category.slug): ${videoKey}`);
	}

	const category = videoKey.slice(0, dotIndex);
	const slug = videoKey.slice(dotIndex + 1);
	return `videos/${category}/${slug}.mp4`;
};

const buildAllowlistSource = () => {
	const videoKeys = [...new Set(Object.values(INPUT_FILE_TO_VIDEO_KEY))].sort();
	const lines = videoKeys.map((videoKey) => {
		const objectKey = objectKeyForVideoKey(videoKey);
		return `\t"${videoKey}": "${objectKey}",`;
	});

	return `export const DOCUMENTATION_VIDEOS = {
${lines.join("\n")}
} as const;

export type DocumentationVideoKey = keyof typeof DOCUMENTATION_VIDEOS;

export const isDocumentationVideoKey = (value: string): value is DocumentationVideoKey =>
\tObject.prototype.hasOwnProperty.call(DOCUMENTATION_VIDEOS, value);

export const getDocumentationVideoObjectKey = (
\tvideoKey: string,
): string | null => {
\tif (!isDocumentationVideoKey(videoKey)) return null;
\treturn DOCUMENTATION_VIDEOS[videoKey];
};
`;
};

const main = async () => {
	const args = parseArgs();

	if (!process.env.AWS_REGION && !args.scanOnly && !args.generateAllowlist) {
		console.warn("AWS_REGION is not set; defaulting to us-east-1 for S3 client.");
	}

	const s3 = new S3Client({
		region: process.env.AWS_REGION || "us-east-1",
	});

	const relativeFiles = await listMp4Files(args.inputDir);
	if (relativeFiles.length === 0) {
		throw new Error(`No .mp4 files found under ${args.inputDir}`);
	}

	const planned = [];

	for (const relativePath of relativeFiles.sort()) {
		const videoKey = resolveVideoKey(relativePath);
		if (!videoKey) {
			throw new Error(`No videoKey mapping for input file: ${relativePath}`);
		}

		const objectKey = objectKeyForVideoKey(videoKey);
		planned.push({ relativePath, videoKey, objectKey });
	}

	console.log(`Found ${planned.length} video(s) in ${args.inputDir}`);
	for (const item of planned) {
		console.log(`  ${item.relativePath}`);
		console.log(`    videoKey: ${item.videoKey}`);
		console.log(`    s3://${args.bucket}/${item.objectKey}`);
	}

	if (args.scanOnly) return;

	if (args.generateAllowlist) {
		const outPath = path.resolve(scriptDir, "../config/documentationVideos.ts");
		await writeFile(outPath, buildAllowlistSource(), "utf8");
		console.log(`Wrote allowlist to ${outPath}`);
		return;
	}

	let uploaded = 0;
	for (const item of planned) {
		const localPath = path.join(args.inputDir, item.relativePath);
		const fileStat = await stat(localPath);
		if (!fileStat.isFile()) {
			throw new Error(`Expected file: ${localPath}`);
		}

		if (args.dryRun) {
			console.log(`[dry-run] would upload ${localPath} -> ${item.objectKey}`);
			continue;
		}

		const body = await readFile(localPath);
		await s3.send(
			new PutObjectCommand({
				Bucket: args.bucket,
				Key: item.objectKey,
				Body: body,
				ContentType: "video/mp4",
			}),
		);
		uploaded += 1;
		console.log(`Uploaded ${item.objectKey}`);
	}

	console.log(
		args.dryRun
			? "Dry run complete (no objects written)."
			: `Upload complete (${uploaded} object(s)).`,
	);
};

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	console.error(usage);
	process.exit(1);
});
