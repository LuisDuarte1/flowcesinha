import {
	ErrorReporterBase,
	type InternalErrorReportingOptions,
} from "flowcesinha";
import { Toucan, type Options as ToucanOptions } from "toucan-js";

export interface SentryOptions extends ToucanOptions {
	context: ExecutionContext;
}

export class SentryErrorReporting extends ErrorReporterBase {
	#ctx: ExecutionContext;
	readonly toucan: Toucan;
	constructor(options: SentryOptions) {
		super();
		this.#ctx = options.context;
		this.toucan = new Toucan(options);
	}

	reportError(error: Error, options: InternalErrorReportingOptions): void {
		this.#ctx.waitUntil(
			(async () => {
				this.toucan.withScope(() => {
					this.toucan.setTags({
						instanceId: options.instanceId,
						workflowName: options.workflowName,
						insideStep: options.stepName !== undefined,
						stepName: options.stepName,
					});
					this.toucan.captureException(error);
				});
			})(),
		);
	}
}
