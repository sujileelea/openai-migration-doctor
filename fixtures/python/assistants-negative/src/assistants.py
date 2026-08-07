from openai import OpenAI
import openai as sdk


class FakeClient:
    class Beta:
        class Threads:
            def create(self):
                return None

        threads = Threads()

    beta = Beta()


fake = FakeClient()
fake.beta.threads.create()

client = OpenAI()
client.responses.create(model="gpt-4.1", tools=[{"type": "file_search"}])
getattr(client.beta.threads, method_name)()
factory().beta.assistants.create()
OpenAI().beta.threads.create()
client_alias = client
client_alias.beta.threads.create()
thread_resource = client.beta.threads
thread_resource.create()
create_thread = client.beta.threads.create
create_thread()

OpenAI = FakeClient
shadowed_constructor_client = OpenAI()
shadowed_constructor_client.beta.assistants.list()

sdk = FakeClient()
shadowed_module_client = sdk.OpenAI()
shadowed_module_client.beta.threads.create()

if load_optional_sdk:
    from openai import AsyncOpenAI as ConditionalClient

conditional_client = ConditionalClient()
conditional_client.beta.threads.messages.list("thread_test")

documentation = "client.beta.threads.runs.create(...)"
# client.beta.assistants.create(model="gpt-4.1")
