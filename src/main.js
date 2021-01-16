/*!
Copyright (C) 2021 Cryptium Corporation. All rights reserved.
*/

const { randomBase64url } = require('@cryptium/random-node-js');
const axios = require('axios');

/*
log - optional log instance (must have `trace`, `info`, `warn`, `error` functions), default is `console`
database - object that implements the Webauthz Data interface
client_name - string containing application name, for example 'Webauthz Test Application'
grant_redirect_uri - string containing the grant redirect URI, for example `${ENDPOINT_URL}/webauthz/grant`
*/
class Webauthz {
    constructor({ log = console, database, client_name, grant_redirect_uri } = {}) {
        this.log = log;
        this.database = database;
        this.client_name = client_name;
        this.grant_redirect_uri = grant_redirect_uri;
    }

    /**
     * Find an access token for the specified `user_id` and `resource_uri`.
     * 
     * The resource is matched on its origin (scheme, host, and port) and path.
     * 
     * Path matching is performed by splitting the path into segments, then looking for a
     * match starting with the all the segments and proceding toward the root path.
     * 
     * If a matching access token is found and has not expired, it will be returned.
     * 
     * If a matching access token is found and has expired, and a refresh token is found that has not expired,
     * the function attempts to automatically refresh the access token. If the refresh succeeds, the new
     * access token and new refresh token are stored with their new expiration dates, and the new access token
     * is returned.
     * 
     * Otherwise, null is returned.
     *
     * @param {*} resource_uri the URI of the resource for which an access token is required
     * @param {*} user_id application-defined unique identifier for the user; single-user applications choose a value like 'main'
     */
    async getAccessToken({ resource_uri, user_id } = {}) {
        const parsedResourceURL = new URL(resource_uri);
        const pathParts = parsedResourceURL.pathname.split('/');
        const pathList = [];
        for (let i = pathParts.length - 1; i > 0; i -= 1) {
            const pathPrefix = pathParts.slice(0, i + 1).join('/');
            pathList.push(pathPrefix);
        }
        pathList.push('/');

        const accessTokenRecord = await this.database.fetchAccessToken({ user_id, origin: parsedResourceURL.origin, pathList });
        if (accessTokenRecord === null) {
            return null;
        }

        let { access_token, access_token_not_after, refresh_token_exists, refresh_token_not_after, client_id, client_state } = accessTokenRecord;
        // automatic refresh may be possible if access token expired but we have a valid refresh token
        if (typeof access_token_not_after === 'number' && Date.now() > access_token_not_after) {
            if (refresh_token_exists) {
                if (typeof refresh_token_not_after === 'number' && Date.now() > refresh_token_not_after) {
                    // refresh token expired, we cannot use the access token at all
                    return null;
                }
                const { access_token: new_access_token } = await this.exchange({ client_id, client_state, refresh: true, user_id });
                if (typeof new_access_token === 'string' && new_access_token.length > 0) {
                    this.log.info('getAccessToken: obtained new access token with refresh');
                    access_token = new_access_token;
                } else {
                    this.log.error('getAccessToken: failed to obtain new access token with refresh');
                    return null;
                }
            } else {
                this.log.info('getAccessToken: access token expired, no refresh token available');
                return null;
            }
        }
        return access_token;
    }

    /**
     * Fetch the discovery document from the network and store in the database.
     * 
     * Returns the discovery document.
     *
     * @param {*} webauthz_discovery_uri where to find the discovery document
     */
    async fetchDiscoveryURI(webauthz_discovery_uri) {
        try {
            // fetch the webauthz discovery document
            const webauthzDiscoveryResponse = await axios.get(webauthz_discovery_uri, {
                headers: {
                    Accept: 'application/json',
                },
            });
            const configuration = webauthzDiscoveryResponse.data;
            const isConfigurationCreated = await this.database.storeConfiguration(webauthz_discovery_uri, configuration);
            if (!isConfigurationCreated) {
                this.log.info('fetchDiscoveryURI: failed to store webauthz configuration data');
                throw new Error('failed to store webauthz configuration data');
            }
            return configuration;
        } catch (err) {
            this.log.error('fetchDiscoveryURI: webauthz discovery failed', err);
            throw new Error('webauthz discovery failed');
        }
    }

    async getConfiguration(webauthz_discovery_uri) {
        // check if we already have the discovery info
        let configuration = await this.database.fetchConfiguration(webauthz_discovery_uri);
        if (typeof configuration !== 'object' || configuration === null) {
            configuration = await this.fetchDiscoveryURI(webauthz_discovery_uri);
        }
        
        this.log.info(`fetchDiscoveryURI: webauthz configuration: ${JSON.stringify(configuration)}`);
        return configuration;
    }

    async registerWithURI(webauthz_register_uri) {
        // we have not yet registered with the webauthz server, so do that now
        const registrationRequest = {
            client_name: this.client_name,
            grant_redirect_uri: this.grant_redirect_uri,
        };

        try {
            const registrationResponse = await axios.post(webauthz_register_uri, JSON.stringify(registrationRequest), {
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
            });
            const registration = registrationResponse.data;
            this.log.info(`registerWithURI: registration data ${JSON.stringify(registration)}`); // NOTE: don't log tokens in production! // TODO: use the log library to only log tokens in debug/trace level, and set default level to info...

            const isRegistrationCreated = await this.database.storeRegistration(webauthz_register_uri, registration);
            if (!isRegistrationCreated) {
                this.log.info('registerWithURI: failed to store webauthz registration data');
                throw new Error('failed to store webauthz registration data');
            }

            return registration;
        } catch (err) {
            this.log.error('registerWithURI: webauthz registration failed', err);
            throw new Error('webauthz registration failed');
        }

    }

    async getRegistration(webauthz_register_uri) {
        // check if we are already registered with the webauthz server
        let registration = await this.database.fetchRegistration(webauthz_register_uri);
        if (typeof registration !== 'object' || registration === null) {
            registration = await this.registerWithURI(webauthz_register_uri);
        }

        return registration;
    }

    // for example user_id: 'sparky', resource_uri: 'http://example.com/resource/1', http_response: err.response
    // where http_response is an object like { status: 401, statusText: 'Unauthorized', headers: { 'www-authenticate': 'Bearer realm=example webauthz_discovery_uri=https://example.com scope=test path=/' } }

    /**
     * 
     * @param {*} param0 
     */
    async checkResponseForWebauthz({ user_id, resource_uri, http_response }) {
        const { status, statusText, headers: { 'www-authenticate': authenticate } = {} } = http_response;
        this.log.info(`checkResponseForWebauthz: resource response ${status} ${statusText}`);
        // look for webauthz response before parsing the header
        if (authenticate && authenticate.toLowerCase().startsWith('bearer ') && authenticate.includes('webauthz_discovery_uri=')) {
            this.log.info(`checkResponseForWebauthz: www-authenticate: ${authenticate}`);
            const attributeMap = {};
            const attributeKvList = authenticate.substr('bearer '.length).split(',');
            attributeKvList.forEach((item) => {
                const [key, value] = item.trim().split('=');
                if (value.startsWith('"') && value.endsWith('"')) {
                    attributeMap[key] = decodeURIComponent(value.substring(1, value.length-1));
                } else {
                    attributeMap[key] = decodeURIComponent(value);
                }
            });
            this.log.info(`checkResponseForWebauthz: www-authenticate bearer attributes: ${JSON.stringify(attributeMap)}`);
            const { realm = null, scope = null, webauthz_discovery_uri = null, path = null } = attributeMap;
            if (webauthz_discovery_uri) {
                // it's a webauthz compatible resource, we can request access
                return {
                    resource_uri,
                    realm,
                    scope,
                    webauthz_discovery_uri,
                    path,
                    user_id, // so only the specified user can manage the request
                };
            }
        }
        return null; // didn't find a webauthz challenge in the server response
    }

    async createAccessRequest({ resource_uri, realm, scope, webauthz_discovery_uri, path, user_id }, context) {

        const configuration = await this.getConfiguration(webauthz_discovery_uri);
        const { webauthz_register_uri, webauthz_request_uri } = configuration;
        const registration = await this.getRegistration(webauthz_register_uri);

        // we are registered with webauthz server, so prepare the redirect uri

        const requestId = randomBase64url(16); // the client_state for webauthz protocol

        // parse `webauthz_request_uri` to add our own query parameters (it might already have some)
        const parsedWebauthzRequestURI = new URL(webauthz_request_uri);
        const webauthzRequestParams = new URLSearchParams(parsedWebauthzRequestURI.search);
        webauthzRequestParams.append('client_id', registration.client_id);
        webauthzRequestParams.append('client_state', requestId);
        webauthzRequestParams.append('realm', realm);
        webauthzRequestParams.append('scope', scope);
        webauthzRequestParams.append('path', path);
        parsedWebauthzRequestURI.search = webauthzRequestParams.toString();
        const access_request_uri = parsedWebauthzRequestURI.toString();
    
        const requestRecord = {
            resource_uri,
            realm,
            scope,
            webauthz_discovery_uri,
            path,
            user_id, // so only the specified user can manage the request
            context, // application-specific, for example { method, body, ... }, whatever is needed to repeat the same request after access is approved
            access_request_uri, // the redirect location
            status: 'redirect',
        };

        const isCreated = await this.database.createAccessRequest(requestId, requestRecord);
        if (isCreated) {
            return {
                client_state: requestId,
                ...requestRecord,
            };
        }
        throw new Error('failed to create access request');
    }

    async getAccessRequest(webauthzRequestId, user_id) {
        const requestRecord = await this.database.fetchAccessRequest(webauthzRequestId);
        if (typeof requestRecord !== 'object' || requestRecord === null) {
            throw new Error('not found');
        }

        const { resource_uri, status, realm, scope, webauthz_discovery_uri, path, user_id: stored_user_id, access_request_uri, context } = requestRecord;
        if (stored_user_id && user_id !== stored_user_id) {
            throw new Error('access denied');
        }

        return { resource_uri, status, realm, scope, webauthz_discovery_uri, path, user_id, access_request_uri, context };
        /*
        if (status === 'granted') {
            return { resource_uri, status };
        }
        if (status === 'denied') {
            return { resource_uri, status };
        }
        if (status === 'redirect' && access_request_uri) {
            return { resource_uri, status, redirect: access_request_uri };
        }

    
        return { resource_uri, status: 'redirect', redirect: webauthzRequestURI };
        */
    }

    async exchange({ client_id, client_state, grant_token, refresh = false, user_id }) {
        // lookup the request
        const webauthzRequest = await this.database.fetchAccessRequest(client_state);
        if (typeof webauthzRequest !== 'object' || webauthzRequest === null) {
            this.log.info(`exchange: client_state ${client_state} not found`);
            throw new Error('not found');
        }

        const { resource_uri, realm, scope, webauthz_discovery_uri, path, access_request_uri, user_id: stored_user_id, refresh_token, refresh_token_not_after } = webauthzRequest;
        if (stored_user_id && user_id !== stored_user_id) {
            throw new Error('access denied');
        }

        const configuration = await this.getConfiguration(webauthz_discovery_uri);
        const { webauthz_register_uri, webauthz_exchange_uri } = configuration;
        const registration = await this.getRegistration(webauthz_register_uri);

        const { client_id: stored_client_id, client_token } = registration;

        if (client_id !== stored_client_id) {
            this.log.error(`exchange: client_id ${client_id} does not match stored client_id ${stored_client_id}`);
            throw new Error('not found');
        }

        let exchangeRequest;
        if (grant_token) {
            // after access request is granted, exchange the grant token for an access token
            exchangeRequest = {
                grant_token,
                access_request_uri,
            };
        } else if (refresh && refresh_token) {
            // use refresh token to request a new access token
            if (typeof refresh_token_not_after === 'number' && Date.now() > refresh_token_not_after) {
                this.log.error('exchange: refresh token expired');
                throw new Error('access denied'); // TODO: but need to mark it for caller that they need to do a new request
            }
            exchangeRequest = {
                refresh_token,
                access_request_uri,
            };
        } else {
            this.log.error('exchange: input grant_token or stored refresh_token is required');
            throw new Error('invalid request');
        }

        this.log.info(`exchange: exchange request: ${JSON.stringify(exchangeRequest)}`);
        this.log.info(`exchange: exchange authorization: ${client_token}`);

        try {
            const exchangeResponse = await axios.post(webauthz_exchange_uri, JSON.stringify(exchangeRequest), {
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${client_token}`,
                },
            });
            const { access_token: new_access_token, access_token_max_seconds: new_access_token_max_seconds, refresh_token: new_refresh_token, refresh_token_max_seconds: new_refresh_token_max_seconds } = exchangeResponse.data;
            if (typeof new_access_token !== 'string' || new_access_token.length === 0) {
                this.log.error('exchange: no access token in response');

                // mark the request as denied
                await this.database.editAccessRequest(client_state, { ...webauthzRequest, status: 'denied' });

                throw new Error('access denied');
            }

            let new_access_token_not_after = null;
            if (typeof new_access_token_max_seconds === 'number') {
                new_access_token_not_after = Date.now() + (new_access_token_max_seconds * 1000); // convert to timestamp in milliseconds
            }
            let new_refresh_token_not_after = null;
            if (typeof new_refresh_token_max_seconds === 'number') {
                new_refresh_token_not_after = Date.now() + (new_refresh_token_max_seconds * 1000); // convert to timestamp in milliseconds
            }

            const resourceURL = new URL(resource_uri);

            const accessTokenRecord = {
                origin: resourceURL.origin, // protocol, hostname, and port
                realm,
                scope,
                path,
                access_token: new_access_token,
                access_token_not_after: new_access_token_not_after,
                refresh_token_exists: typeof new_refresh_token === 'string' && new_refresh_token.length > 0, // token value stored in request record, see below
                refresh_token_not_after: new_refresh_token_not_after, // so we can determine if we can use the refresh token before we do a bunch of queries
                client_id, // needed for refresh
                client_state,  // needed for refresh
                user_id, // application-specific: who is allowed to use this token (we will check it when we use the token)
            };
    
            const id = randomBase64url(16);
            const isCreated = await this.database.createAccessToken(id, accessTokenRecord);
            if (!isCreated) {
                throw new Error('failed to store access token');
            }
    
            // mark the request as granted, and update the refresh token
            await this.database.editAccessRequest(client_state, { ...webauthzRequest, status: 'granted', refresh_token: new_refresh_token, refresh_token_not_after: new_refresh_token_not_after });
    
            // sometimes the caller just needs the resource, and it will call accessTokenForURL later; sometimes the caller needs the access_token immediately.
            // it's authorized so we return both here for convenience
            return { resource_uri, status: 'granted', access_token: new_access_token };
        } catch (err) {
            if (err.response) {
                this.log.error(`exchange: token exchange failed: ${err.response.status} ${err.response.statusText}`);
                this.log.error('exchange: no access token in response');
            } else {
                this.log.error('exchange failed', err);
            }
            throw new Error('exchange failed');
        }
    }
}

export { Webauthz };
