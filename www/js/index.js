/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Wait for the deviceready event before using any of Cordova's device APIs.
// See https://cordova.apache.org/docs/en/latest/cordova/events/events.html#deviceready
document.addEventListener("deviceready", onDeviceReady, false);

function onDeviceReady() {
  if (navigator.connection.type == Connection.NONE) {
    navigator.notification.alert("An internet connection is required to continue");
    return;
  }

  setupPushChannel();
  window.location.replace("https://www.3dprintlog.com");
}

// Android groups notifications by channel, and the channel is what a user mutes in system
// settings. Every message the API sends targets print_status; without the channel existing
// first those messages land in the default channel and per-category muting silently stops
// working. Created here, on the local page, because cordova.js is gone after navigation.
//
// The plugin's JS module clobbers the global FirebasexMessaging (see its plugin.xml).
function setupPushChannel() {
  if (typeof FirebasexMessaging === "undefined") {
    return;
  }

  FirebasexMessaging.createChannel({
    id: "print_status",
    name: "Print status",
    importance: 4
  });
}
