export const DOCUMENTATION_VIDEOS = {
	"department.departments-tab": "videos/department/departments-tab-v2.mp4",
	"getting-started.welcome-dashboard": "videos/getting-started/welcome-dashboard-v2.mp4",
	"getting-started.workspace": "videos/getting-started/workspace.mp4",
	"product.compare-versions-redline-view":
		"videos/product/compare-versions-redline-view.mp4",
	"product.compliance-tab": "videos/product/compliance-information-v2.mp4",
	"product.label-components": "videos/product/label-components-v2.mp4",
	"product.label-tags": "videos/product/label-tags-v2.mp4",
	"product.operational-parameters": "videos/product/operational-parameters-v2.mp4",
	"product.product-information": "videos/product/product-information-v2.mp4",
	"product.product-plan-review-overview": "videos/product/product-plan-review-overview-v2.mp4",
	"product.product-specifications": "videos/product/product-specifications-v2.mp4",
	"product.products-intro": "videos/product/products-intro-v2.mp4",
	"product.symbols-graphics": "videos/product/symbols-graphics-v2.mp4",
	"projects.projects-tab": "videos/projects/projects-tab-v2.mp4",
	"reports-analytics.overview": "videos/reports-analytics/overview.mp4",
	"working-with-files.source-files-archive-bookmarks":
		"videos/working-with-files/source-files-archive-bookmarks.mp4",
} as const;

export type DocumentationVideoKey = keyof typeof DOCUMENTATION_VIDEOS;

export const isDocumentationVideoKey = (value: string): value is DocumentationVideoKey =>
	Object.prototype.hasOwnProperty.call(DOCUMENTATION_VIDEOS, value);

export const getDocumentationVideoObjectKey = (
	videoKey: string,
): string | null => {
	if (!isDocumentationVideoKey(videoKey)) return null;
	return DOCUMENTATION_VIDEOS[videoKey];
};