import { ApolloServer, PlaygroundConfig } from 'apollo-server-express';
import * as dotenv from 'dotenv';
import resolvers from './data/resolvers';
import typeDefs from './data/schema';
import { getEnv } from './data/utils';
import { Conversations, Customers } from './db/models';
import { graphqlPubsub } from './pubsub';
import { getArray, setArray } from './redisClient';

// load environment variables
dotenv.config();

const NODE_ENV = getEnv({ name: 'NODE_ENV' });

let playground: PlaygroundConfig = false;

if (NODE_ENV !== 'production') {
  playground = {
    settings: {
      'general.betaUpdates': false,
      'editor.theme': 'dark',
      'editor.reuseHeaders': true,
      'tracing.hideTracingResponse': true,
      'editor.fontSize': 14,
      'editor.fontFamily': `'Source Code Pro', 'Consolas', 'Inconsolata', 'Droid Sans Mono', 'Monaco', monospace`,
      'request.credentials': 'include',
    },
  };
}

const apolloServer = new ApolloServer({
  typeDefs,
  resolvers,
  playground,
  uploads: false,
  context: ({ req, res }) => {
    return {
      user: req && req.user,
      res,
    };
  },
  subscriptions: {
    keepAlive: 10000,
    path: '/subscriptions',

    onConnect(_connectionParams, webSocket) {
      webSocket.on('message', async message => {
        const parsedMessage = JSON.parse(message).id || {};

        if (parsedMessage.type === 'messengerConnected') {
          // get status from redis
          const connectedClients = await getArray('connectedClients');
          const clients = await getArray('clients');

          const messengerData = parsedMessage.value;
          const integrationId = messengerData.integrationId;
          webSocket.messengerData = parsedMessage.value;

          const customerId = webSocket.messengerData.customerId;

          if (!connectedClients.includes(customerId)) {
            connectedClients.push(customerId);
            await setArray('connectedClients', connectedClients);
          }

          // Waited for 10 seconds to reconnect in disconnect hook and disconnect hook
          // removed this customer from connected clients list. So it means this customer
          // is back online
          if (!clients.includes(customerId)) {
            clients.push(customerId);
            await setArray('clients', clients);

            // mark as online
            await Customers.markCustomerAsActive(customerId);

            // customer has joined + time
            const conversationMessages = await Conversations.changeCustomerStatus('joined', customerId, integrationId);

            for (const _message of conversationMessages) {
              graphqlPubsub.publish('conversationMessageInserted', {
                conversationMessageInserted: _message,
              });
            }

            // notify as connected
            graphqlPubsub.publish('customerConnectionChanged', {
              customerConnectionChanged: {
                _id: customerId,
                status: 'connected',
              },
            });
          }
        }
      });
    },

    async onDisconnect(webSocket) {
      const messengerData = webSocket.messengerData;

      if (messengerData) {
        // get status from redis
        let connectedClients = await getArray('connectedClients');

        const customerId = messengerData.customerId;
        const integrationId = messengerData.integrationId;

        // Temporarily marking as disconnected
        // If client refreshes his browser, It will trigger disconnect, connect hooks.
        // So to determine this issue. We are marking as disconnected here and waiting
        // for 10 seconds to reconnect.
        connectedClients.splice(connectedClients.indexOf(customerId), 1);
        await setArray('connectedClients', connectedClients);

        setTimeout(async () => {
          // get status from redis
          connectedClients = await getArray('connectedClients');
          const clients = await getArray('clients');

          if (connectedClients.includes(customerId)) {
            return;
          }

          clients.splice(clients.indexOf(customerId), 1);
          await setArray('clients', clients);

          // mark as offline
          await Customers.markCustomerAsNotActive(customerId);

          // customer has left + time
          const conversationMessages = await Conversations.changeCustomerStatus('left', customerId, integrationId);

          for (const message of conversationMessages) {
            graphqlPubsub.publish('conversationMessageInserted', {
              conversationMessageInserted: message,
            });
          }

          // notify as disconnected
          graphqlPubsub.publish('customerConnectionChanged', {
            customerConnectionChanged: {
              _id: customerId,
              status: 'disconnected',
            },
          });
        }, 5000);
      }
    },
  },
});

export default apolloServer;
