import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { useFlowcesinha } from 'flowcesinha';

type Env = {
	// Add your bindings here, e.g. Workers KV, D1, Workers AI, etc.
	MY_WORKFLOW: Workflow;
	WORKFLOWS_BUCKET: R2Bucket;
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
				options: {},
			},
			async (event, step) => {
				await step.reversableDo(
					'Book flight',
					async () => {
						// logic to book a flight
						console.log("I'm booking a flight");
						return 'LIS-LAX';
					},
					async (data) => {
						console.log("I'm reversing flight booking", data);
						return;
					},
				);

				await step.reversableDo(
					'Book hotel',
					async () => {
						// logic to book a hotel
						console.log("I'm booking a hotel");
						return 'Hilton';
					},
					async (data) => {
						console.log("I'm reversing hotal booking", data);
						return;
					},
				);

				// step policy will apply to both do function and the reverse function too
				await step.reversableDo(
					'Book car',
					{
						retries: {
							delay: 1000,
							limit: 5,
							backoff: 'constant',
						},
					},
					async () => {
						// logic to book a car
						console.log("I'm booking a car");
						// will always error out, for testing
						throw new Error('Car booking failed');
					},
					async () => {
						console.log("I'm reversing car rental");
						return;
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
