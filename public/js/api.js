/**
 * API Wrapper Module
 * Wraps fetch() with Authorization header injection and global error handling.
 * Depends on auth.js being loaded first (provides getToken, clearToken).
 */

/**
 * Handle response errors globally.
 * - 401: clear token and redirect to login
 * - 403: show disabled account message if applicable
 * @param {Response} response
 * @returns {Response} the original response for further handling
 */
async function handleResponseErrors(response) {
  if (response.status === 401) {
    clearToken();
    window.location.href = '/index.html';
    return response;
  }

  if (response.status === 403) {
    try {
      const cloned = response.clone();
      const data = await cloned.json();
      if (data.error && data.error.toLowerCase().includes('disabled')) {
        alert('Your account has been disabled. Please contact an administrator.');
        clearToken();
        window.location.href = '/index.html';
      }
    } catch (e) {
      // If we can't parse the response body, skip the disabled check
    }
    return response;
  }

  return response;
}

/**
 * Perform a GET request with Authorization header.
 * @param {string} url - The URL to fetch
 * @returns {Promise<Response>}
 */
async function apiGet(url) {
  const token = getToken();
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  await handleResponseErrors(response);
  return response;
}

/**
 * Perform a POST request with JSON body and Authorization header.
 * @param {string} url - The URL to fetch
 * @param {object} body - The request body (will be JSON-stringified)
 * @returns {Promise<Response>}
 */
async function apiPost(url, body) {
  const token = getToken();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  await handleResponseErrors(response);
  return response;
}

/**
 * Perform a PATCH request with JSON body and Authorization header.
 * @param {string} url - The URL to fetch
 * @param {object} body - The request body (will be JSON-stringified)
 * @returns {Promise<Response>}
 */
async function apiPatch(url, body) {
  const token = getToken();
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  await handleResponseErrors(response);
  return response;
}
