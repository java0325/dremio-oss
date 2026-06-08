/*
 * Copyright (C) 2017-2019 Dremio Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as env from "env-var";
import path from "path";

const DEV_PROXY_CONFIG_PATH = env.get("DEV_PROXY_CONFIG_PATH").asString();
const resolvedProxyConfigPath = DEV_PROXY_CONFIG_PATH
  ? path.resolve(process.cwd(), DEV_PROXY_CONFIG_PATH)
  : undefined;

export const devServer = {
  client: {
    overlay: false,
  },
  compress: true,
  headers: {
    "Content-Security-Policy":
      "default-src 'self';" +
      "connect-src 'self' api.segment.io cdn.segment.com *.sentry.io sentry.io https://*.intercom.io wss://*.intercom.io uploads.intercomcdn.com uploads.intercomcdn.eu uploads.intercomusercontent.com;" +
      "img-src 'self' blob: data: https:;" +
      "font-src 'self' js.intercomcdn.com fonts.intercomcdn.com;" +
      "frame-src 'self' youtube.com https://www.youtube-nocookie.com;" +
      "media-src 'self' js.intercomcdn.com;" +
      "object-src 'none';" +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' www.googletagmanager.com cdn.segment.com app.intercom.io widget.intercom.io js.intercomcdn.com;" +
      "style-src 'self' 'unsafe-inline';",
  },
  historyApiFallback: {
    disableDotRule: true,
  },
  hot: true,
  port: 3005,
  proxy: resolvedProxyConfigPath ? require(resolvedProxyConfigPath).proxy : undefined,
  static: {
    directory: "./public",
  },
};
