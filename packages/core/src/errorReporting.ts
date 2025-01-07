export interface InternalErrorReportingOptions {
	stepName?: string;
	instanceId: string;
	workflowName: string;
}

export abstract class ErrorReporterBase {
	abstract reportError(
		error: Error,
		options: InternalErrorReportingOptions,
	): void;
}

export class ConsoleErrorReporter extends ErrorReporterBase {
	constructor() {
		super();
	}

	reportError(error: Error, options: InternalErrorReportingOptions): void {
		console.error({
			...options,
			insideStep: options.stepName !== undefined,
			name: error.name,
			message: error.message,
			stack: error.stack,
			cause: error.cause,
		});
	}
}
