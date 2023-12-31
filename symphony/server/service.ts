import { Server, WebSocket } from "ws";
import { createServer } from "http";
import { createMachine, interpret, EventObject } from "xstate";
import { assign } from "@xstate/immer";
import OpenAI from "openai";
import { pipe } from "fp-ts/lib/function";
import * as O from "fp-ts/Option";
import * as dotenv from "dotenv";
import {
  decodeFunctionName,
  encodeFunctionName,
  getColor,
  getModelIdFromAssistant,
  getAssistantFromConnections,
  getSystemDescription,
  getUserFromConnections,
  getDescriptionFromConnection,
  getNameFromFunction,
} from "../utils/functions";
import { Generation, Message, Context } from "../utils/types";
import { v4 as id } from "uuid";
import * as S from "fp-ts/string";
import axios from "axios";
import * as AR from "fp-ts/Array";
import { UUID } from "crypto";
import * as fs from "fs";
import { FineTuningJob } from "openai/resources/fine-tuning";
import { FileObject } from "openai/resources";

dotenv.config();

const DATABASE_ENDPOINT = "http://127.0.0.1:3002";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface SymphonyEvent extends EventObject {
  type: "CLIENT_MESSAGE";
  data: Message;
}

const server = createServer();
const wss = new Server({ server });

const createGeneration = (
  message: Message,
  conversationId: UUID
): Generation => {
  return {
    id: id(),
    message,
    conversationId,
    timestamp: new Date().toISOString(),
  };
};

const machine = createMachine(
  {
    id: "machine",
    initial: "idle",
    context: {
      id: id(),
      generations: [],
      connections: [
        {
          name: "assistant",
          color: "#d4d4d4",
          description:
            "You are a friendly assistant. Keep your responses short.",
          modelId: "gpt-4-1106-preview",
        },
        {
          name: "user",
          color: getColor(),
          description: "I'm a user. I'm here to talk to you.",
          modelId: "human",
        },
      ],
    },
    schema: {
      context: {} as Context,
    },
    predictableActionArguments: true,
    on: {
      CLIENT_MESSAGE: [
        {
          target: "gpt",
          cond: (_, event) => event.data.role === "user",
          actions: [
            assign((context, event) => {
              const { generations, id } = context;
              const { data } = event as SymphonyEvent;

              context.generations = [
                ...generations,
                createGeneration(data, id),
              ];
            }),
            "receiveUserMessageFromClient",
            "sendHistoryToClients",
          ],
        },
        {
          target: "restore",
          cond: (_, event) => event.data.role === "restore",
        },
        {
          target: "idle",
          cond: (_, event) => event.data.role === "history",
          actions: ["sendHistoryToClients"],
        },
        {
          target: "new",
          cond: (_, event) => event.data.role === "new",
        },
        {
          target: "deleteConversation",
          cond: (_, event) => event.data.role === "deleteConversation",
        },
        {
          target: "edit",
          cond: (_, event) => event.data.role === "edit",
        },
        {
          target: "deleteGeneration",
          cond: (_, event) => event.data.role === "deleteGeneration",
        },
        {
          target: "finetune",
          cond: (_, event) => event.data.role === "finetune",
        },
        {
          target: "idle",
          cond: (_, event) => event.data.role === "models",
          actions: ["sendModelsToClients"],
        },
        {
          target: "idle",
          cond: (_, event) => event.data.role === "personalize",
          actions: [
            assign((context, event) => {
              const { connections } = context;
              const { data } = event;
              const { content: updatedConnection } = data;

              context.connections = pipe(
                connections,
                AR.filter(
                  (connection) => connection.name !== updatedConnection.name
                ),
                AR.append(updatedConnection)
              );
            }),
            "sendContextToClients",
          ],
        },
        {
          target: "switch",
          cond: (_, event) => event.data.role === "switch",
          actions: [
            assign((context, event) => {
              const { data } = event;
              const { content: conversationId } = data;
              context.id = conversationId;
            }),
          ],
        },
      ],
    },
    states: {
      function: {
        invoke: {
          src: (context) =>
            new Promise((resolve) => {
              const { generations } = context;

              const toolCalls = pipe(
                generations,
                AR.last,
                O.map(
                  (generation: Generation) => generation.message.tool_calls
                ),
                O.chain(O.fromNullable)
              );

              if (O.isSome(toolCalls)) {
                Promise.all(
                  toolCalls.value.map(async (toolCall) => {
                    const name = decodeFunctionName(toolCall.function.name);
                    const args = JSON.parse(toolCall.function.arguments);

                    return axios
                      .post(
                        `${
                          name.includes(".ts")
                            ? "http://localhost:3003"
                            : name.includes(".py")
                            ? `http://0.0.0.0:3004`
                            : ""
                        }/${getNameFromFunction(name)}`,
                        args
                      )
                      .then((response) => {
                        const { data } = response;

                        const message = {
                          tool_call_id: toolCall.id,
                          role: "tool",
                          name: encodeFunctionName(name),
                          content: JSON.stringify(data),
                        };

                        return message;
                      })
                      .catch((error) => {
                        const message = {
                          tool_call_id: toolCall.id,
                          role: "tool",
                          name: encodeFunctionName(name),
                          content: JSON.stringify({
                            errorMessage: error.message,
                          }),
                        };

                        return message;
                      });
                  })
                ).then((messages) => {
                  resolve(messages);
                });
              } else {
                resolve(null);
              }
            }).then((response) => response),
          onDone: [
            {
              target: "gpt",
              cond: (_, event) => event.data,
              actions: [
                assign((context, event) => {
                  const { id, generations } = context;
                  const { data: messages } = event;

                  const newGenerations = messages.map((message) =>
                    createGeneration(message, id)
                  );

                  context.generations = [...generations, ...newGenerations];
                }),
                "sendToolMessagesToClients",
              ],
            },
            {
              target: "idle",
            },
          ],
        },
      },
      gpt: {
        invoke: {
          src: (context) => {
            const pythonFunctions = JSON.parse(
              fs.readFileSync(
                "./symphony/server/python/descriptions.json",
                "utf8"
              )
            );

            const typescriptFunctions = JSON.parse(
              fs.readFileSync(
                "./symphony/server/typescript/descriptions.json",
                "utf8"
              )
            );

            return openai.chat.completions.create({
              messages: [
                {
                  role: "system",
                  content: getSystemDescription(
                    pipe(
                      context.connections,
                      getAssistantFromConnections,
                      getDescriptionFromConnection
                    ),
                    pipe(
                      context.connections,
                      getUserFromConnections,
                      getDescriptionFromConnection
                    )
                  ),
                },
                ...context.generations.map((generation) => generation.message),
              ],
              model: pipe(
                context.connections,
                getAssistantFromConnections,
                getModelIdFromAssistant
              ),
              tools: [...typescriptFunctions, ...pythonFunctions].map((fn) => ({
                type: "function",
                function: fn,
              })),
            });
          },
          onDone: {
            target: "function",
            actions: [
              assign((context, event) => {
                const { id, generations } = context;
                const { data } = event;
                const { choices } = data;
                const { message } = choices[0];

                context.generations = [
                  ...generations,
                  createGeneration(message, id),
                ];
              }),
              "sendAssistantMessageToClients",
            ],
          },
          onError: {
            target: "idle",
            actions: [
              (_, event) => {
                console.log(event);
              },
            ],
          },
        },
      },
      new: {
        invoke: {
          src: () => Promise.resolve({}),
          onDone: {
            target: "idle",
            actions: [
              assign((context) => {
                context.id = id();
                context.generations = [];
              }),
            ],
          },
        },
      },
      restore: {
        invoke: {
          src: async () => {},
          onDone: {
            target: "idle",
            actions: ["sendContextToClients"],
          },
        },
      },
      switch: {
        invoke: {
          src: async (context) => {
            const { id } = context;

            const { data: generations } = await axios.get(
              `${DATABASE_ENDPOINT}/generations?conversationId=eq.${id}&order=timestamp`
            );

            return pipe(
              generations,
              AR.filter(
                (generation: Generation) => generation.conversationId === id
              )
            );
          },
          onDone: {
            target: "idle",
            actions: [
              assign((context, event) => {
                const { data: generations } = event;
                context.generations = generations;
              }),
              "sendConversationToClients",
            ],
          },
        },
      },
      deleteConversation: {
        invoke: {
          src: async (context) => {
            const { id } = context;

            await axios
              .delete(
                `${DATABASE_ENDPOINT}/generations?conversationId=eq.${id}`,
                {
                  headers: {
                    Prefer: "return=representation",
                  },
                }
              )
              .then((response) => {
                const deletedGeneration = pipe(response.data, AR.head);

                if (O.isSome(deletedGeneration)) {
                  wss.clients.forEach((client: WebSocket) => {
                    client.send(
                      JSON.stringify({
                        role: "deleteConversation",
                        content: deletedGeneration.value,
                      })
                    );
                  });
                }
              });
          },
          onDone: {
            target: "new",
          },
        },
      },
      edit: {
        invoke: {
          src: async (_, event) => {
            const { data: message } = event;
            const { content } = message;

            await axios
              .patch(
                `${DATABASE_ENDPOINT}/generations?id=eq.${content.id}`,
                {
                  message: content.message,
                },
                {
                  headers: {
                    Prefer: "return=representation",
                  },
                }
              )
              .then((response) => {
                const updatedGeneration = pipe(response.data, AR.head);

                if (O.isSome(updatedGeneration)) {
                  wss.clients.forEach((client: WebSocket) => {
                    client.send(
                      JSON.stringify({
                        role: "edit",
                        content: updatedGeneration.value,
                      })
                    );
                  });
                }
              });

            return content;
          },
          onDone: {
            target: "idle",
            actions: [
              assign((context, event) => {
                const { generations } = context;
                const { data } = event;
                const { id, message } = data;

                context.generations = pipe(
                  generations,
                  AR.map((generation: Generation) => {
                    if (generation.id === id) {
                      return { ...generation, message };
                    } else {
                      return generation;
                    }
                  })
                );
              }),
            ],
          },
        },
      },
      deleteGeneration: {
        invoke: {
          src: async (_, event) => {
            const { data: message } = event;
            const { content: generationId } = message;

            await axios
              .delete(
                `${DATABASE_ENDPOINT}/generations?id=eq.${generationId}`,
                {
                  headers: {
                    Prefer: "return=representation",
                  },
                }
              )
              .then((response) => {
                const deletedGeneration = pipe(response.data, AR.head);

                if (O.isSome(deletedGeneration)) {
                  wss.clients.forEach((client: WebSocket) => {
                    client.send(
                      JSON.stringify({
                        role: "deleteGeneration",
                        content: deletedGeneration.value,
                      })
                    );
                  });
                }
              });

            return generationId;
          },
          onDone: {
            target: "idle",
            actions: [
              assign((context, event) => {
                const { generations } = context;
                const { data: generationId } = event;

                context.generations = pipe(
                  generations,
                  AR.filter(
                    (generation: Generation) => generation.id !== generationId
                  )
                );
              }),
            ],
          },
        },
      },
      finetune: {
        invoke: {
          src: async (context) => {
            const { data: generations } = await axios.get(
              `${DATABASE_ENDPOINT}/generations?order=timestamp`
            );

            const conversations = generations.reduce((acc, generation) => {
              const key = generation.conversationId;

              if (!acc[key]) {
                acc[key] = [
                  {
                    role: "system",
                    content: getSystemDescription(
                      pipe(
                        context.connections,
                        getAssistantFromConnections,
                        getDescriptionFromConnection
                      ),
                      pipe(
                        context.connections,
                        getUserFromConnections,
                        getDescriptionFromConnection
                      )
                    ),
                  },
                ];
              }

              acc[key].push(generation.message);
              return acc;
            }, {});

            const conversationsJsonl = Object.values(conversations)
              .map((conversation) => JSON.stringify({ messages: conversation }))
              .join("\n");

            fs.writeFile(
              "./symphony/server/training-data.jsonl",
              conversationsJsonl,
              () => {}
            );

            return openai.files
              .create({
                file: fs.createReadStream(
                  "./symphony/server/training-data.jsonl"
                ),
                purpose: "fine-tune",
              })
              .then((file: FileObject) => {
                return openai.fineTuning.jobs
                  .create({
                    training_file: file.id,
                    model: pipe(
                      context.connections,
                      getAssistantFromConnections,
                      getModelIdFromAssistant
                    ),
                  })
                  .then((job: FineTuningJob) => {
                    return job;
                  });
              });
          },
          onDone: {
            target: "idle",
            actions: ["sendFinetuneMessageToClients"],
          },
        },
      },
      idle: {},
    },
  },
  {
    actions: {
      receiveUserMessageFromClient: async (context) => {
        const { generations } = context;

        const recentUserGeneration = pipe(
          generations,
          AR.findLast(
            (generation: Generation) => generation.message.role === "user"
          )
        );

        if (O.isSome(recentUserGeneration)) {
          wss.clients.forEach((client: WebSocket) => {
            client.send(JSON.stringify(recentUserGeneration.value));
          });

          await axios.post(
            `${DATABASE_ENDPOINT}/generations`,
            recentUserGeneration.value
          );
        }
      },
      sendAssistantMessageToClients: async (context) => {
        const { generations } = context;

        const recentAssistantGeneration = pipe(
          generations,
          AR.findLast(
            (generation: Generation) => generation.message.role === "assistant"
          )
        );

        if (O.isSome(recentAssistantGeneration)) {
          wss.clients.forEach((client: WebSocket) => {
            client.send(JSON.stringify(recentAssistantGeneration.value));
          });

          await axios.post(
            `${DATABASE_ENDPOINT}/generations`,
            recentAssistantGeneration.value
          );
        }
      },
      sendToolMessagesToClients: async (context, event) => {
        const { generations } = context;
        const { data: messages } = event;

        messages.forEach(async (message: Message) => {
          const toolGeneration = pipe(
            generations,
            AR.findFirst(
              (generation: Generation) =>
                generation.message.role === "tool" &&
                generation.message.tool_call_id === message.tool_call_id
            )
          );

          if (O.isSome(toolGeneration)) {
            wss.clients.forEach((client: WebSocket) => {
              client.send(JSON.stringify(toolGeneration.value));
            });

            await axios.post(
              `${DATABASE_ENDPOINT}/generations`,
              toolGeneration.value
            );
          }
        });
      },
      sendConversationToClients: (context) => {
        const { generations } = context;

        wss.clients.forEach((client: WebSocket) => {
          client.send(
            JSON.stringify({
              role: "switch",
              content: generations.filter(
                (generation) => generation.message.role !== "system"
              ),
            })
          );
        });
      },
      sendContextToClients: (context) => {
        wss.clients.forEach((client: WebSocket) => {
          client.send(
            JSON.stringify({
              role: "restore",
              content: context,
            })
          );
        });
      },
      sendFinetuneMessageToClients: (_, event) => {
        const { data: job } = event;

        wss.clients.forEach((client: WebSocket) => {
          client.send(
            JSON.stringify({
              role: "finetune",
              content: job,
            })
          );
        });
      },
      sendHistoryToClients: async () => {
        const { data: generations } = await axios.get(
          `${DATABASE_ENDPOINT}/generations?order=timestamp`
        );

        const history = pipe(
          generations,
          AR.map((generation: Generation) => generation.conversationId),
          AR.uniq(S.Eq),
          AR.map((conversationId) =>
            pipe(
              generations,
              AR.filter(
                (generation: Generation) =>
                  generation.conversationId === conversationId
              ),
              AR.head,
              O.map(({ conversationId, message, timestamp }) => ({
                id: conversationId,
                timestamp,
                message,
              })),
              O.toUndefined
            )
          ),
          AR.reverse
        );

        wss.clients.forEach((client: WebSocket) => {
          client.send(
            JSON.stringify({
              role: "history",
              content: history,
            })
          );
        });
      },
      sendModelsToClients: async () => {
        const { data: models } = await openai.models.list();

        wss.clients.forEach((client: WebSocket) => {
          client.send(
            JSON.stringify({
              role: "models",
              content: models,
            })
          );
        });
      },
    },
  }
);

const service = interpret(machine).start();

type Data = string | Buffer | ArrayBuffer | Buffer[] | ArrayBufferView;

wss.on("connection", (connection: WebSocket) => {
  connection.on("message", (message: Data) => {
    const decodedMessage = message.toString();
    const parsedMessage = JSON.parse(decodedMessage);

    const symphonyEvent: SymphonyEvent = {
      type: "CLIENT_MESSAGE",
      data: parsedMessage,
    };

    service.send(symphonyEvent);
  });
});

server.listen(3001);
