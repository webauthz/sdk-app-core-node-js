sdk-app-core-node-js
====================

Webauthz SDK for a NodeJS web application.

This library integrates into the website back-end JavaScript using NodeJS.

Use this library to obtain access to resources using Webauthz.

# Usage

To integrate this library with an application you will need two imports. One is
for this library, the other one is for a data driver that manages the persistent
data storage for this library. In this example, we use an in-memory storage
driver:

```
const { WebauthzMemoryDatabase } = require('@webauthz/sdk-app-data-memory-js');
const { Webauthz } = require('@webauthz/sdk-app-core-node-js');
```

Then, create an instance of the Webauthz class and configure it:

```
// webauthz plugin with in-memory database
const webauthzPlugin = new Webauthz({
    database: new WebauthzMemoryDatabase(),
    client_name: 'Test Webauthz Application',
    grant_redirect_uri: `${ENDPOINT_URL}/webauthz/grant`,
});
```

The next place to integrate the library is wherever you attempt to access a resource
that may require an access token that can be obtained via Webauthz. Use the library
to automatically find a matching access token for the resource if you already have one,
and check the HTTP response to see if it includes a Webauthz challenge that indicates
you need a new access token:

```
// check if an access token is already available for this resource and for this user
const accessToken = await webauthzPlugin.getAccessToken({ user_id: req.session.username, resource_uri: resourceURL });
if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
}

try {
    // make the http request for the resource
    const response = await axios.get(resourceURL, { headers });
    if (response.data) {
        // success
        return res.render('main', { content: JSON.stringify(response.data, null, 2), url: resourceURL, username: req.session.username });
    }
} catch (err) {
    // request failed, check for a Webauthz challenge in the response
    if (err.response) {
        const webauthzInfo = await webauthzPlugin.checkResponseForWebauthz({ user_id: req.session.username, resource_uri: resourceURL, http_response: err.response });
        if (webauthzInfo) {
            // found a Webauthz challenge; prepare a Webauthz access request for the resource
            const { access_request_uri } = await webauthzPlugin.createAccessRequest(webauthzInfo, { method: 'GET' });
            // show the error we got from the resource, and also the fact that it supports Webauthz
            return res.render('main', {
                error: `${err.response.status} ${err.response.statusText}`,
                url: resourceURL,
                webauthz: access_request_uri,
                username: req.session.username
            });
        }
        // did not find a Webauthz challenge; show the status from the http response
        return res.render('main', { error: `${err.response.status} ${err.response.statusText}`, url: resourceURL, username: req.session.username });
    } else {
        console.error('unexpected error while accessing resource', err);
    }
}
```

In this example, the user interface renders the `webauthz` property
(whose value was set to `access_request_uri`) as a link
to the authorization server to obtain access to the resource.
The user clicks on that link to continue. Alternatively, the application
may immediately redirect the user to the `access_request_uri` without an
intermediate step:

```
        if (webauthzInfo) {
            // found a Webauthz challenge; prepare a Webauthz access request for the resource
            const { access_request_uri } = await webauthzPlugin.createAccessRequest(webauthzInfo, { method: 'GET' });
            // redirect the user to the authorization server to obtain access
            res.status(303);
            res.set('Location', access_request_uri);
            res.end();
            return;
        }
```

At the authorization server, the user will either approve access to the
resource, or find out they don't have permission to do that, or they might
deny the request themselves. The authorization server will redirect the user
back to the application's `grant_redirect_uri` with some query parameters
added to indicate the status of the access request.

The application must have a handler for the `grant_redirect_uri` to receive
grant tokens when the request is approved, or the 'denied' status when it
is not approved:

```
expressApp.get('/webauthz/grant', session, httpGetWebauthzGrant);
```

The `session` parameter there is the middleware that manages session cookies
and authenticates the user. The user must be authenticated to the application
to make use of the grant token, because all tokens are scoped to individual
users.

The function `httpGetWebauthzGrant` can be very brief because it just needs
to call the `exchange` function of the library with the received parameters
and the user id. For example:

```
async function httpGetWebauthzGrant(req, res) {

    // only authenticated users allowed because we need to check that it's the same user associated to the request
    const isAuthenticated = isSessionAuthenticated(req.session);
    if (!isAuthenticated) {
        res.status(401);
        return res.render('main', { error: 'login to manage webauthz requests' });
    }

    const { client_id, client_state, grant_token, status } = req.query;

    if (typeof client_id !== 'string' || !client_id) {
        res.status(400);
        return res.render('fault', { fault: 'client_id required' });
    }
    if (typeof client_state !== 'string' || !client_state) {
        res.status(400);
        return res.render('fault', { fault: 'client_state required' });
    }

    try {
        // load the access request identified by client_state, scoped to the current user
        const { resource_uri } = await webauthzPlugin.getAccessRequest(client_state, req.session.username);

        if (status === 'denied') {
            res.status(403);
            return res.render('main', { error: 'access denied', url: resource_uri, username: req.session.username });
        }
    
        try {
            // exchange the grant token for an access token
            const { status: exchange_status } = await webauthzPlugin.exchange({ client_id, client_state, grant_token, user_id: req.session.username });
            if (exchange_status === 'granted') {
                // redirect the user to the user interface where we access the resource
                res.status(303);
                res.set('Location', `/resource?url=${encodeURIComponent(resource_uri)}`);
                res.end();
                return;
            }
        } catch (err) {
            console.error('httpGetWebauthzGrant: error', err);
            res.status(403);
            return res.render('main', { error: 'access denied', url: resource_uri, username: req.session.username });
        }
    
    } catch (err) {
        console.error('httpGetWebauthzGrant: failed to retrieve access request', err);
        res.status(400);
        return res.render('fault', { fault: 'invalid request' });
    }
}
```

The `/resource?url=` location shown in the example represents the user interface where
we access the resource, using the code shown above:

```
// check if an access token is already available for this resource and for this user
const accessToken = await webauthzPlugin.getAccessToken({ user_id: req.session.username, resource_uri: resourceURL });
if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
}
```

This time, an access token would be found and the request would succeed.

# API

An application will need to use the following functions:

* getAccessToken
* checkResponseForWebauthz
* createAccessRequest
* getAccessRequest
* exchange

The following helper functions are used internally:

* fetchDiscoveryURI
* getConfiguration
* registerWithURI
* getRegistration

## getAccessToken

Example usage:

```
const accessToken = await webauthzPlugin.getAccessToken({ user_id: req.session.username, resource_uri: resourceURL });
if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
}
```

Find an access token for the specified `user_id` and `resource_uri`.
 
The resource is matched on its origin (scheme, host, and port) and path.
 
Path matching is performed by splitting the path into segments, then looking for a
match starting with the all the segments and proceding toward the root path.
 
If a matching access token is found and has not expired, it will be returned.

If a matching access token is found and has expired, and a refresh token is found that has not expired,
the function attempts to automatically refresh the access token. If the refresh succeeds, the new
access token and new refresh token are stored with their new expiration dates, and the new access token
is returned.

Otherwise, the function returns null.

Parameters:

* `param0` (object, required) is an object with the properties `user_id` and `resource_uri`

Properties of `param0`:

* `user_id` (string, required) is application-defined unique identifier for the user; single-user applications choose a value like 'main'
* `resource_uri` (string, required) the URI of the resource for which an access token is required

Return value: an access token (string) that can be used in an HTTP request, or null if
an access token was not found.

## checkResponseForWebauthz

Example usage:

```
const webauthzInfo = await webauthzPlugin.checkResponseForWebauthz({ user_id: req.session.username, resource_uri: resourceURL, http_response: err.response });
if (webauthzInfo) {
    // found a Webauthz challenge; prepare a Webauthz access request for the resource
    const { access_request_uri } = await webauthzPlugin.createAccessRequest(webauthzInfo, { method: 'GET' });
    // redirect the user to the authorization server to obtain access
    res.status(303);
    res.set('Location', access_request_uri);
    res.end();
    return;
}
```

Check an HTTP response for a Webauthz challenge.
 
A Webauthz challenge is identified by the presence of a `WWW-Authenticate` header
in the HTTP response with the `Bearer` authentication scheme and an auth-param
named `webauthz_discovery_uri`.

If found, the authentication challenge is parsed to obtain the necessary
information, which is returned as an object (named `webauthzInfo` in the example).

Otherwise, the function returns null.

Parameters:

* `param0` (object, required) is an object with the properties `user_id`, `resource_uri`, and `http_response`

Properties of `param0`:

* `user_id` (string, required) is application-defined unique identifier for the user; single-user applications choose a value like 'main'
* `resource_uri` (string, required) the URI of the resource for which an access token is required
* `http_response` (object, required) the HTTP response object with the properties `status`, `statusText`, and `headers`
  (these are present in the standard response object for express apps), where `status` is an integer with the HTTP status code,
  `statusText` is a string with the HTTP status message, and `headers` is an object with the HTTP response headers; we look
  for a header named `www-authenticate`

Return value: an object with the Webauthz info required to make an access request, or null

NOTE: the library requires the complete HTTP response with status and headers, and not just the value of the
`WWW-Authenticate` header, for simplicity and also flexibility to look for additional information in other headers,
or to check only if the response code is 401, etc.

## createAccessRequest

Example usage:

```
const webauthzInfo = await webauthzPlugin.checkResponseForWebauthz({ user_id: req.session.username, resource_uri: resourceURL, http_response: err.response });
if (webauthzInfo) {
    // found a Webauthz challenge; prepare a Webauthz access request for the resource
    const { access_request_uri } = await webauthzPlugin.createAccessRequest(webauthzInfo, { method: 'GET' });
    // redirect the user to the authorization server to obtain access
    res.status(303);
    res.set('Location', access_request_uri);
    res.end();
    return;
}
```

Create and store an access request record.

The access request record is used to store the status of a pending Webauthz
access request, and also to store a Webauthz refresh token if it is received.
This record should persist for the duration that the access token or refresh
token are needed.

The function returns the access request information in an object. Typically
an application only needs to extract the `access_request_uri` from this object
to continue by redirecting the user there to request access.

Parameters:

* `param0` (object, required) is an object with the Webauthz information returned by `checkResponseForWebauthz`
* `param1` (object, optional) is an object with application-specific contextual information about the request

Properties of `param0`:

* `user_id` (string, required) is application-defined unique identifier for the user; single-user applications choose a value like 'main'
* `resource_uri` (string, required) the URI of the resource for which an access token is required
* `realm` (string, required) the value of the `realm` auth-param from the `WWW-Authenticate` header
* `scope` (string, required) the value of the `scope` auth-param from the `WWW-Authenticate` header
* `path` (string, required) the value of the `path` auth-param from the `WWW-Authenticate` header
* `webauthz_discovery_uri` (string, required) the value of the `webauthz_discovery_uri` auth-param from the `WWW-Authenticate` header

Properties of `param1` are application-specific, you can put anything you need in here.
For example, you might put information on how to re-try the request after obtaining the
access token, or where to redirect the user after obtaining the access token or where
to redirect the user if the access request is denied, where those URLs include some
state information in the query parameters. The context would then be available to the
application when the user returns from the authorization server.

Return value: an object with the `access_request_uri` used to redirect the user to request access

## getAccessRequest

Example usage:

```
// load the access request identified by client_state, scoped to the current user
const { resource_uri } = await webauthzPlugin.getAccessRequest(client_state, req.session.username);
```

Retrieve an access request record.

The access request record is used to store the status of a pending Webauthz
access request, and also to store a Webauthz refresh token if it is received.
This record should persist for the duration that the access token or refresh
token are needed.

The function returns the access request information in an object. A minimal
integration of Webauthz into an application might not require the use of this
function.

Parameters:

* `param0` (string, required) the access request unique id, also known as the `client_state`
* `param1` (string, required) the unique user id, also known as `user_id`

Return value: an object with the access request status

## exchange

Example usage 1:

```
// exchange the grant token for an access token
const { status: exchange_status } = await webauthzPlugin.exchange({ client_id, client_state, grant_token, user_id: req.session.username });
if (exchange_status === 'granted') {
    // redirect the user to the user interface where we access the resource
    res.status(303);
    res.set('Location', `/resource?url=${encodeURIComponent(resource_uri)}`);
    res.end();
    return;
}
```

Example usage 2:

```
// exchange the refresh token for an access token
const { client_id } = await webauthzPlugin.getAccessRequest(client_state, req.session.username);
const { status: exchange_status } = await webauthzPlugin.exchange({ client_id, client_state, refresh: true, user_id: req.session.username });
if (exchange_status === 'granted') {
    // redirect the user to the user interface where we access the resource
    res.status(303);
    res.set('Location', `/resource?url=${encodeURIComponent(resource_uri)}`);
    res.end();
    return;
}
```

Exchange a grant token or refresh token for an access token.

A grant token is only available immediately after the user obtains permission to access
the resource. A refresh token is obtained by the `exchange` method itself and is stored
in the access request record automatically, so to use a refresh token the caller only
has to replace the `grant_token` property a `refresh` property with a `true` value.

If the exchange is successful, the function returns an object with `resource_uri`, `status`,
and `access_token` properties.

Otherwise, the function throws an error.

Parameters:

* `param0` (object, required) is an object with the properties `client_id`, `client_state`, `user_id`,
and either `grant_token` or `refresh`.

Properties of `param0`:

* `client_id` (string, required) is a value provided by the authorization server in the registration response
* `client_state` (string, required) is a unique identifier for the access request, returned by the `createAccessRequest` function
* `user_id` (string, required) is application-defined unique identifier for the user; single-user applications choose a value like 'main'
* `grant_token` (string, required for first exchange) the grant token from the query parameters
* `refresh` (boolean, required for subsequent exchange) the value `true` indicates to use a refresh token instead of grant token

Return value: an object with `resource_uri`, `status`, and `access_token` properties.

## fetchDiscoveryURI

Example usage:

```
const configuration = await this.fetchDiscoveryURI(webauthz_discovery_uri);
```

Fetch the discovery document from the network and store in the database.

Returns the discovery document.

Parameters:

* `param0` (string, required) the `webauthz_discovery_uri` value from the Webauthz challenge

Return value: an object with the authorization server configuration

NOTE: this function is used internally by the library, and an application typically will
not need to call this function.

## getConfiguration

Example usage:

```
const configuration = await this.getConfiguration(webauthz_discovery_uri);
```

Fetch the discovery document from persistent storage. If the document is not found
or has expired, automatically fetch a new version from network and store in the database.

Returns the discovery document.

Parameters:

* `param0` (string, required) the `webauthz_discovery_uri` value from the Webauthz challenge

Return value: an object with the authorization server configuration

NOTE: this function is used internally by the library, and an application typically will
not need to call this function.

## registerWithURI

Example usage:

```
const registration = await this.registerWithURI(webauthz_register_uri);
```

Register the application with the authorization server.

Returns the registration info `client_id` and `client_token` that are used
for further back-end communication with the authorization server.

Parameters:

* `param0` (string, required) the `webauthz_register_uri` value from the Webauthz configuration

Return value: an object with the application's registration info

NOTE: this function is used internally by the library, and an application typically will
not need to call this function.

## getRegistration

Example usage:

```
const registration = await this.getRegistration(webauthz_register_uri);
```

Fetch the registration info from persistent storage. If the document is not found
or has expired, automatically register again and store the new registration in
the database.

Returns the registration info.

Parameters:

* `param0` (string, required) the `webauthz_register_uri` value from the Webauthz configuration

Return value: an object with the application's registration info

NOTE: this function is used internally by the library, and an application typically will
not need to call this function.

# Storage

The library uses an abstract `database` object to store and lookup information in
pesistent storage. The application must provide an object that implements the storage
interface documented here.

See also [sdk-app-data-memory-js](https://github.com/webauthz/sdk-app-data-memory-js/) for an example
in-memory implementation that is useful for testing.

## storeConfiguration

Example usage:

```
const isCreated = await database.storeConfiguration(webauthz_discovery_uri, configuration);
```

Create new record, or replace existing record. Should not throw exception unless there is a write error.

The `configuration` object is stored using the `webauthz_discovery_uri` as the primary key.

Parameters:

* `param0` (string, required) the value of `webauthz_discovery_uri`
* `param1` (object, required) is an object with the configuration info to store

Returns a boolean indicating whether the write operation was successful.

## fetchConfiguration

Example usage:

```
const configuration = await database.fetchConfiguration(webauthz_discovery_uri);
```

Fetch an existing configuration from storage.

Parameters:

* `param0` (string, required) the value of `webauthz_discovery_uri`

Return the configuration object, or
null if it is not found.

## storeRegistration

Example usage:

```
const isCreated = await database.storeRegistration(webauthz_register_uri, registration);
```

Create new registration record, or replace existing record. Should not throw exception unless there is a write error.

The `registration` record is stored using the `webauthz_register_uri` as the primary key.

Parameters:

* `param0` (string, required) the value of `webauthz_register_uri`
* `param1` (object, required) is an object with the registration info to store

Returns a boolean indicating whether the write operation was successful.

##  fetchRegistration

Example usage:

```
const registration = await database.fetchRegistration(webauthz_register_uri);
```

Fetch an existing registration from storage.


Parameters:

* `param0` (string, required) the value of `webauthz_register_uri`

Return the registration object, or
null if it is not found.

## createAccessRequest

Example usage:

```
const isCreated = await database.createAccessRequest(requestId, requestRecord);
```

Creates new access request record. Should throw exception if a record with
the specified unique id already exists.

The unique record id is called the `client_state` in the core library.


Parameters:

* `param0` (string, required) the value of the access request unique id, also known as `client_state`
* `param1` (object, required) is an object with the access request record to store

Returns a boolean indicating whether the write operation was successful.

## fetchAccessRequest

Example usage:

```
const requestRecord = await database.fetchAccessRequest(requestId);
```

Fetch an existing access request record from storage.

Parameters:

* `param0` (string, required) the value of the access request unique id, also known as `client_state`

Returns the request object,
or null if it is not found.

The unique record id is called the `client_state` in the core library.

## editAccessRequest

Example usage:

```
const isEdited = await database.editAccessRequest(requestId, requestRecord);
```

Edit an existing access request record. Should throw exception if the record is
not found or the write operation fails.

The unique record id is called the `client_state` in the core library.

Parameters:

* `param0` (string, required) the value of the access request unique id, also known as `client_state`
* `param1` (object, required) is an object with the access request record to store

Returns a boolean indicating whether the write operation was successful.

## createAccessToken

Example usage:

```
const isCreated = await database.createAccessToken(id, accessTokenRecord);
```

Creates new access token record. Should throw exception if a record with
the specified unique id already exists.

Parameters:

* `param0` (string, required) the value of the access token unique id
* `param1` (object, required) is an object with the access token record to store

Returns a boolean indicating whether the write operation was successful.

The `accessTokenRecord` parameter MUST include `user_id`, `origin`, and `path`
properties for the creation of an index to the access token.

## fetchAccessToken

Example usage:

```
const accessToken = await database.fetchAccessToken({ user_id, origin, pathList });
```

Fetch an existing access token matching the following criteria:

* `user_id` is equal to the stored `user_id`
* `origin` is equal to the stored `origin`
* `path` is equal to the first matching value in `pathList`

The application should provide a `pathList` array with the paths to search,
starting with the longest path first. For example: `pathList: ['/api/contact/1234','/api/contact','/api','/']`

Parameters:

* `param0` (object, required) an object with properties representing the matching criteria

Properties of `param0`:

* `user_id` (string, required) the `user_id` required for matching access tokens
* `origin` (string, required) the `origin` required for matching access tokens
* `pathList` (array of strings, required) the list of `path` values to use for matching tokens, in order

Returns an access token (string) if found, or null if not found.

# Build

```
npm run lint
npm run build
```
