from openai import OpenAI as OpenAIClient
import openai as sdk

renamed_client = OpenAIClient()
module_client = sdk.OpenAI()

renamed_client.beta.assistants.list()
module_client.beta.threads.runs.retrieve("thread_test", "run_test")
