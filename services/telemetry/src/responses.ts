const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export function jsonResponse(
  body: unknown,
  status = 200,
  additionalHeaders?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headersToRecord(additionalHeaders) },
  });
}

export function textResponse(
  body: string,
  contentType: string,
  additionalHeaders?: HeadersInit,
): Response {
  return new Response(body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': contentType,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...headersToRecord(additionalHeaders),
    },
  });
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      result[key] = value;
    });
  }
  return result;
}
