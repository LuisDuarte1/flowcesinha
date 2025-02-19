import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { useFlowcesinha } from 'flowcesinha';
import { SentryErrorReporting } from 'flowcesinha-sentry';

type Env = {
	// Add your bindings here, e.g. Workers KV, D1, Workers AI, etc.
	MY_WORKFLOW: Workflow;
};

// User-defined params passed to your workflow
type Params = {
	email: string;
	metadata: Record<string, string>;
};

export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		return useFlowcesinha(
			{
				ctx: this.ctx,
				env: this.env,
				event,
				step,
				workflowName: this.constructor.name, // equivalent to writing "MyWorkflow"
				config: {
					// Add your custom error reporter here
					errorReporter: new SentryErrorReporting({
						context: this.ctx,
						dsn: 'YOUR-SENTRY-DSN',
					}),

					globalFailureHandler: (error) => {
						console.log('Workflow failed!', error);
					},
				},
			},
			async (event, step) => {
				await step.do(
					"i'm a step",
					{
						retries: {
							delay: 1000,
							limit: 5,
							backoff: 'constant',
						},
					},
					async () => {
						// always errors out
						throw new Error('Ola');
					},
				);

				return 'finished';
			},
		);
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname.startsWith('/favicon')) {
			return Response.json({}, { status: 404 });
		}

		// Get the status of an existing instance, if provided
		const id = url.searchParams.get('instanceId');
		if (id) {
			const instance = await env.MY_WORKFLOW.get(id);
			return Response.json({
				status: await instance.status(),
			});
		}

		// Spawn a new instance and return the ID and status
		const instance = await env.MY_WORKFLOW.create();
		return Response.json({
			id: instance.id,
			details: await instance.status(),
		});
	},
};
