const fs = require('fs');

async function collectGarbage() {
  return ngx.fetch('http://127.0.0.1:4646/v1/system/gc', { method: 'PUT' });
}

async function shellExecute(command, args, options) {
  return ngx.fetch('http://127.0.0.1:24422/shell', {
    method: 'POST',
    body: JSON.stringify({
      command,
      args,
      options
    })
  });
}

async function nginxReload() {
  return shellExecute('/bin/sh', [
    '-c',
    'nomad system gc && sleep 1 && nginx -s reload'
  ]);
}

function processEnv(object) {
  const result = {};

  for (const key in object) {
    const value = object[key];

    if (typeof value === 'undefined' || value === null) {
      continue;
    }

    result[key] = value.toString();
  }

  return result;
}

async function startDeployedWorker(
  workerId,
  artifactUrl,
  env,
  enableHttp,
  command,
  args
) {
  const templates = [];
  const networks = [];
  const services = [];

  if (enableHttp) {
    networks.push({
      DynamicPorts: [
        {
          HostNetwork: '',
          Label: 'HTTP',
          To: 0,
          Value: 0
        }
      ]
    });

    services.push({
      Name: workerId,
      Provider: 'nomad',
      PortLabel: 'HTTP',
      Tags: ['worker'],
      Meta: {
        PPP_WORKER_ID: workerId
      },
      Checks: [
        {
          Interval: 5000000000,
          PortLabel: 'HTTP',
          Timeout: 2000000000,
          Type: 'tcp'
        }
      ]
    });

    templates.push({
      ChangeMode: 'script',
      ChangeScript: {
        Args: [
          '-c',
          `/usr/bin/curl -s -d '{"command":"/bin/sh","args":["-c","nomad system gc && sleep 1 && nginx -s reload"]}' -H "Content-Type: application/json" -X POST http://127.0.0.1:24422/shell`
        ],
        Command: '/bin/sh',
        FailOnError: false,
        Timeout: 5000000000
      },
      DestPath: 'local/workers.conf',
      EmbeddedTmpl: `
        {{ range nomadService "${workerId}" }}
          location /workers/{{ .Name | toLower }}/ {
            default_type application/json;

            if ($request_method = OPTIONS ) {
              add_header Access-Control-Allow-Origin '*';
              add_header Access-Control-Allow-Headers '*';
              add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS, PUT, PATCH, DELETE';

              return 200 '{}';
            }

            proxy_pass http://127.0.0.1:{{ .Port }}/;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header Origin "\${scheme}://\${proxy_host}";
            proxy_buffering off;
          }
        {{ end }}
      `
    });
  }

  return ngx.fetch('http://127.0.0.1:4646/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      Job: {
        Datacenters: ['ppp'],
        Constraints: [
          {
            LTarget: '${node.datacenter}',
            Operand: '=',
            RTarget: 'ppp'
          }
        ],
        Type: 'service',
        ID: `worker-${workerId}`,
        TaskGroups: [
          {
            Name: workerId,
            Count: 1,
            Scaling: {
              Min: 1,
              Max: 1
            },
            Networks: networks,
            Tasks: [
              {
                Artifacts: [
                  {
                    GetterSource: `${artifactUrl}?t=${Date.now()}`,
                    RelativeDest: `local/nginx/workers/${workerId}`
                  }
                ],
                Templates: templates,
                Services: services,
                Config: {
                  command: command || '/usr/bin/node',
                  args: args || [
                    `\${NOMAD_TASK_DIR}/nginx/workers/${workerId}/${workerId}.mjs`
                  ]
                },
                Meta: {
                  PPP_WORKER_ID: workerId
                },
                Env: processEnv(
                  Object.assign(
                    {
                      NODE_OPTIONS: '--max-old-space-size=256'
                    },
                    env,
                    {
                      PPP_WORKER_ID: workerId
                    }
                  )
                ),
                Driver: 'raw_exec',
                Name: 'worker',
                RestartPolicy: {
                  Attempts: 5,
                  Delay: 5000000000,
                  Interval: 300000000000,
                  Mode: 'delay'
                }
              }
            ]
          }
        ]
      }
    })
  });
}

async function restartDeployedWorker(workerId) {
  const response = await ngx.fetch(
    `http://127.0.0.1:4646/v1/job/worker-${workerId}/allocations`
  );

  if (response.status === 200) {
    const allocations = await response.json();
    const allocation = allocations.find(
      (a) => a.TaskStates.worker.State === 'running'
    );

    if (typeof allocation !== 'undefined') {
      return ngx.fetch(
        `http://127.0.0.1:4646/v1/client/allocation/${allocation.ID}/restart`,
        {
          method: 'PUT'
        }
      );
    } else {
      return 404;
    }
  } else {
    return response;
  }
}

async function stopDeployedWorker(workerId, env) {
  const response = await ngx.fetch(
    `http://127.0.0.1:4646/v1/job/worker-${workerId}?purge=true`,
    {
      method: 'DELETE'
    }
  );

  const headers = new Headers();

  headers.set('Content-Type', 'application/json');

  await ngx.fetch('http://127.0.0.1:24422/redis', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      options: {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
        tls: env.REDIS_TLS
          ? {
              servername: env.REDIS_HOST
            }
          : void 0,
        username: env.REDIS_USERNAME,
        db: env.REDIS_DATABASE,
        password: env.REDIS_PASSWORD
      },
      command: 'hdel',
      args: [`aspirant:${env.ASPIRANT_ID}`, workerId]
    })
  });

  return response;
}

async function env(r) {
  if (r.method.toUpperCase() === 'GET') {
    try {
      r.return(200, fs.readFileSync('/etc/nginx/env.json').toString());
    } catch (e) {
      r.error(e);

      r.return(
        404,
        JSON.stringify({
          nginx: {
            message: 'Missing or corrupted environment file.',
            exception: 'BadEnvironmentFileError',
            status_code: 404,
            ok: false
          }
        })
      );
    }
  } else {
    r.return(404);
  }
}

async function resurrect(r) {
  if (r.method.toUpperCase() === 'POST') {
    try {
      const requestBody = JSON.parse(r.requestText);
      const requiredFields = [
        'ASPIRANT_ID',
        'GLOBAL_PROXY_URL',
        'REDIS_HOST',
        'REDIS_PORT'
      ];

      for (let i = 0; i < requiredFields.length; i++) {
        const field = requiredFields[i];

        if (typeof requestBody[field] === 'undefined') {
          r.return(
            422,
            JSON.stringify({
              nginx: {
                message: `Missing required field: ${field}.`,
                exception: 'ValidationError',
                status_code: 422,
                ok: false
              }
            })
          );

          return;
        }
      }

      const env = {
        ASPIRANT_ID: requestBody.ASPIRANT_ID,
        GLOBAL_PROXY_URL: requestBody.GLOBAL_PROXY_URL,
        REDIS_HOST: requestBody.REDIS_HOST,
        REDIS_PORT: +requestBody.REDIS_PORT,
        REDIS_TLS: requestBody.REDIS_TLS === 'true' ? 'true' : '',
        REDIS_USERNAME: requestBody.REDIS_USERNAME,
        REDIS_DATABASE: +requestBody.REDIS_DATABASE,
        REDIS_PASSWORD: requestBody.REDIS_PASSWORD
      };

      if (typeof env.REDIS_USERNAME === 'undefined') {
        env.REDIS_USERNAME = 'default';
      }

      if (
        typeof env.REDIS_DATABASE !== 'number' ||
        isNaN(+env.REDIS_DATABASE)
      ) {
        env.REDIS_DATABASE = 0;
      }

      if (typeof env.REDIS_PASSWORD !== 'string') {
        env.REDIS_PASSWORD = '';
      }

      fs.writeFileSync('/etc/nginx/env.json', JSON.stringify(env));

      const headers = new Headers();

      headers.set('Content-Type', 'application/json');

      const redisResponse = await ngx.fetch('http://127.0.0.1:24422/redis', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          options: {
            host: env.REDIS_HOST,
            port: env.REDIS_PORT,
            tls: env.REDIS_TLS
              ? {
                  servername: env.REDIS_HOST
                }
              : void 0,
            username: env.REDIS_USERNAME,
            db: env.REDIS_DATABASE,
            password: env.REDIS_PASSWORD
          },
          command: 'hgetall',
          args: [`aspirant:${env.ASPIRANT_ID}`]
        })
      });
      const response = await redisResponse.text();

      if (redisResponse.status === 200) {
        const workers = JSON.parse(response);

        Object.keys(workers).forEach((workerId) => {
          const workerData = JSON.parse(workers[workerId]);

          let args = workerData.args || '';

          if (args && typeof args === 'string') {
            args = JSON.parse(args);
          }

          startDeployedWorker(
            workerId,
            workerData.artifactUrl,
            Object.assign({}, env, workerData.env),
            workerData.enableHttp,
            workerData.command,
            args
          );
        });

        await nginxReload();

        r.return(200, '{"nginx":{"resurrected":true,"ok":true}}');
      } else {
        r.return(redisResponse.status, response);
      }
    } catch (e) {
      r.error(e);

      r.return(
        422,
        JSON.stringify({
          nginx: {
            message: 'Bad payload.',
            exception: 'ValidationError',
            status_code: 422,
            ok: false
          }
        })
      );
    }
  } else {
    r.return(404);
  }
}

async function v1(r) {
  try {
    const uri = r.uri.endsWith('/') ? r.uri.slice(0, -1) : r.uri;
    const method = r.method.toUpperCase();

    switch (uri) {
      case '/api/v1/workers':
        if (method === 'GET') {
          await collectGarbage();

          const response = await ngx.fetch(
            'http://127.0.0.1:4646/v1/jobs?prefix=worker'
          );
          const jobs = await response.json();

          r.return(
            response.status,
            JSON.stringify(
              jobs
                .filter((j) => j.Status !== 'dead')
                .map((j) => {
                  return {
                    _id: j.ID.split('worker-')[1]
                  };
                })
            )
          );
        } else if (
          method === 'POST' ||
          method === 'PUT' ||
          method === 'DELETE'
        ) {
          await collectGarbage();

          try {
            const requestBody = JSON.parse(r.requestText);

            if (
              !requestBody.workerId ||
              typeof requestBody.workerId !== 'string' ||
              !requestBody.workerId.length
            ) {
              r.return(
                422,
                JSON.stringify({
                  nginx: {
                    message: 'Missing or invalid field: workerId.',
                    exception: 'ValidationError',
                    status_code: 422,
                    ok: false
                  }
                })
              );

              return;
            }

            let response;
            let env = {};

            if (method === 'POST' || method === 'DELETE') {
              try {
                const aspirantEnv = JSON.parse(
                  fs.readFileSync('/etc/nginx/env.json').toString()
                );

                if (typeof aspirantEnv === 'object') {
                  env = Object.assign({}, env, aspirantEnv);
                }
              } catch (e) {
                r.error(e);

                void 0;
              }

              if (typeof requestBody.env === 'object') {
                env = Object.assign({}, env, requestBody.env);
              }
            }

            if (method === 'POST') {
              if (
                !requestBody.artifactUrl ||
                typeof requestBody.artifactUrl !== 'string' ||
                !requestBody.artifactUrl.length
              ) {
                r.return(
                  422,
                  JSON.stringify({
                    nginx: {
                      message: 'Missing or invalid field: artifactUrl.',
                      exception: 'ValidationError',
                      status_code: 422,
                      ok: false
                    }
                  })
                );

                return;
              }

              let args = requestBody.args || '';

              if (args && typeof args === 'string') {
                args = JSON.parse(args);
              }

              response = await startDeployedWorker(
                requestBody.workerId,
                requestBody.artifactUrl,
                env,
                !!requestBody.enableHttp,
                requestBody.command,
                args
              );

              const headers = new Headers();

              headers.set('Content-Type', 'application/json');

              await ngx.fetch('http://127.0.0.1:24422/redis', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  options: {
                    host: env.REDIS_HOST,
                    port: env.REDIS_PORT,
                    tls: env.REDIS_TLS
                      ? {
                          servername: env.REDIS_HOST
                        }
                      : void 0,
                    username: env.REDIS_USERNAME,
                    db: env.REDIS_DATABASE,
                    password: env.REDIS_PASSWORD
                  },
                  command: 'hset',
                  args: [
                    `aspirant:${env.ASPIRANT_ID}`,
                    requestBody.workerId,
                    JSON.stringify({
                      env,
                      artifactUrl: requestBody.artifactUrl,
                      enableHttp: !!requestBody.enableHttp,
                      command: requestBody.command,
                      args
                    })
                  ]
                })
              });

              await nginxReload();
            } else if (method === 'PUT') {
              response = await restartDeployedWorker(requestBody.workerId);

              if (response === 404) {
                r.return(200, '{"nginx":{"restarted":false,"ok":true}}');

                return;
              } else {
                await nginxReload();
              }
            } else if (method === 'DELETE') {
              response = await stopDeployedWorker(requestBody.workerId, env);

              await nginxReload();
            }

            const text = await response.text();

            if (response.status === 200) {
              const json = JSON.parse(text);

              if (method === 'POST') {
                if (json.EvalID) {
                  r.return(
                    response.status,
                    '{"nginx":{"scheduled":true,"ok":true}}'
                  );
                } else {
                  r.return(
                    response.status,
                    '{"nginx":{"scheduled":false,"ok":true}}'
                  );
                }
              } else if (method === 'PUT') {
                if (typeof json.Index !== 'undefined') {
                  r.return(
                    response.status,
                    '{"nginx":{"restarted":true,"ok":true}}'
                  );
                } else {
                  r.return(
                    response.status,
                    '{"nginx":{"restarted":false,"ok":true}}'
                  );
                }
              } else if (method === 'DELETE') {
                if (json.EvalID) {
                  r.return(
                    response.status,
                    '{"nginx":{"removed":true,"ok":true}}'
                  );
                } else {
                  r.return(
                    response.status,
                    '{"nginx":{"removed":false,"ok":true}}'
                  );
                }
              }
            } else {
              r.return(response.status, text);
            }
          } catch (e) {
            r.error(e);

            r.return(
              422,
              JSON.stringify({
                nginx: {
                  message: 'Bad payload.',
                  exception: 'ValidationError',
                  status_code: 422,
                  ok: false
                }
              })
            );
          }
        } else {
          r.return(404);
        }

        return;

      case '/api/v1/utils/shell_execute':
        if (method === 'POST') {
          try {
            const requestBody = JSON.parse(r.requestText);

            if (
              !requestBody.command ||
              typeof requestBody.command !== 'string' ||
              !requestBody.command.length
            ) {
              r.return(
                422,
                JSON.stringify({
                  nginx: {
                    message: 'Missing required field: command.',
                    exception: 'ValidationError',
                    status_code: 422,
                    ok: false
                  }
                })
              );

              return;
            }

            if (!Array.isArray(requestBody.args)) {
              r.return(
                422,
                JSON.stringify({
                  nginx: {
                    message: 'Invalid field: args.',
                    exception: 'ValidationError',
                    status_code: 422,
                    ok: false
                  }
                })
              );

              return;
            }

            await collectGarbage();

            const response = await shellExecute(
              requestBody.command,
              requestBody.args,
              requestBody.options
            );

            r.return(response.status, '{"nginx":{"scheduled":true,"ok":true}}');
          } catch (e) {
            r.error(e);

            r.return(
              422,
              JSON.stringify({
                nginx: {
                  message: 'Bad payload.',
                  exception: 'ValidationError',
                  status_code: 422,
                  ok: false
                }
              })
            );
          }
        } else {
          r.return(404);
        }

        return;

      case '/api/v1/utils/extract_from_zip':
        if (method === 'POST') {
          try {
            if (!r.args.entry) {
              r.return(
                422,
                JSON.stringify({
                  nginx: {
                    message: 'Missing required path parameter: entry.',
                    exception: 'ValidationError',
                    status_code: 422,
                    ok: false
                  }
                })
              );

              return;
            }

            const result = await r.subrequest('/extract_from_zip_internal', {
              method: 'POST',
              args: r.args.entry
            });

            r.return(result.status, result.responseBody);
          } catch (e) {
            r.error(e);

            r.return(
              422,
              JSON.stringify({
                nginx: {
                  message: 'Bad payload or request path.',
                  exception: 'ValidationError',
                  status_code: 422,
                  ok: false
                }
              })
            );
          }
        } else {
          r.return(404);
        }

        return;
    }

    r.return(404);
  } catch (e) {
    r.error(e);

    r.return(
      500,
      JSON.stringify({
        nginx: {
          message: 'There was an internal server error.',
          exception: 'InternalServerError',
          status_code: 500,
          ok: false
        }
      })
    );
  }
}

export default { v1, resurrect, env };
