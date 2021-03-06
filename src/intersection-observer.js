/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Observable} from './observable';
import {dev} from './log';
import {layoutRectLtwh, rectIntersection, moveLayoutRect} from './layout-rect';
import {listenFor, postMessageToWindows} from './iframe-helper';
import {timer} from './timer';

/**
 * Produces a change entry for that should be compatible with
 * IntersectionObserverEntry.
 *
 * Mutates passed in rootBounds to have x and y according to spec.
 *
 * @param {number} time Time when values below were measured.
 * @param {!./layout-rect.LayoutRectDef} rootBounds Equivalent to viewport.getRect()
 * @param {!./layout-rect.LayoutRectDef} elementLayoutBox Layout box of the element
 *     that may intersect with the rootBounds.
 * @return {!IntersectionObserverEntry} A change entry.
 * @private
 */
export function getIntersectionChangeEntry(
    measureTime, rootBounds, elementLayoutBox) {
  // Building an IntersectionObserverEntry.
  // http://rawgit.com/slightlyoff/IntersectionObserver/master/index.html#intersectionobserverentry
  // These should always be equal assuming rootBounds cannot have negative
  // dimension.
  rootBounds.x = rootBounds.left;
  rootBounds.y = rootBounds.top;

  const boundingClientRect =
      moveLayoutRect(elementLayoutBox, -1 * rootBounds.x, -1 * rootBounds.y);
  dev.assert(boundingClientRect.width >= 0 &&
      boundingClientRect.height >= 0, 'Negative dimensions in ad.');
  boundingClientRect.x = boundingClientRect.left;
  boundingClientRect.y = boundingClientRect.top;

  const intersectionRect =
      rectIntersection(rootBounds, elementLayoutBox) ||
      // No intersection.
      layoutRectLtwh(0, 0, 0, 0);
  intersectionRect.x = intersectionRect.left;
  intersectionRect.y = intersectionRect.top;

  return {
    time: measureTime,
    rootBounds,
    boundingClientRect,
    intersectionRect,
  };
}

/**
 * The IntersectionObserver class lets any element share its viewport
 * intersection data with an iframe of its choice (most likely contained within
 * the element itself.). When instantiated the class will start listening for
 * a 'send-intersection' postMessage from the iframe, and only then  would start
 * sending intersection data to the iframe. The intersection data would be sent
 * when the element is moved inside or outside the viewport as well as on
 * scroll and resize.
 * The element should create an IntersectionObserver instance once the Iframe
 * element is created.
 * The IntersectionObserver class exposes a `fire` method that would send the
 * intersection data to the iframe.
 * The IntersectionObserver class exposes a `onViewportCallback` method that
 * should be called inside if the viewportCallback of the element. This would
 * let the element sent intersection data automatically when there element comes
 * inside or goes outside the viewport and also manage sending intersection data
 * onscroll and resize.
 * Note: The IntersectionObserver would not send any data over to the iframe if
 * it had not requested the intersection data already via a postMessage.
 */
export class IntersectionObserver extends Observable {
  /**
   * @param {!BaseElement} element.
   * @param {!Element} iframe Iframe element which requested the intersection
   *    data.
   * @param {?boolean} opt_is3p Set to `true` when the iframe is 3'rd party.
   */
  constructor(baseElement, iframe, opt_is3p) {
    super();
    /** @private @const */
    this.baseElement_ = baseElement;
    /** @private {?Element} */
    this.iframe_ = iframe;
    /** @private {!Array<{win: !Window, origin: string}>} */
    this.clientWindows_ = [];
    /** @private {boolean} */
    this.is3p_ = opt_is3p || false;
    /** @private {boolean} */
    this.shouldSendIntersectionChanges_ = false;
    /** @private {boolean} */
    this.inViewport_ = false;

    /** @private {!Array<!IntersectionObserverEntry>} */
    this.pendingChanges_ = [];

    /** @private {number} */
    this.flushTimeout_ = 0;

    /** @private @const {function()} */
    this.boundFlush_ = this.flush_.bind(this);

    this.init_();
  }

  init_() {
    // Triggered by context.observeIntersection(…) inside the ad/iframe.
    // We use listen instead of listenOnce, because a single ad/iframe might
    // have multiple parties wanting to receive viewability data.
    // The second time this is called, it doesn't do much but it
    // guarantees that the receiver gets an initial intersection change
    // record.
    listenFor(this.iframe_, 'send-intersections', (data, source, origin) => {
      // This message might be from any window within the iframe, we need
      // to keep track of which windows want to be sent updates.
      if (!this.clientWindows_.some(entry => entry.win == source)) {
        this.clientWindows_.push({win: source, origin});
      }
      this.startSendingIntersectionChanges_();
    }, this.is3p_,
    // For 3P frames we also allow nested frames within them to listen to
    // the intersection changes.
    this.is3p_ /* opt_includingNestedWindows */);

    this.add(() => {
      this.sendElementIntersection_();
    });
  }
  /**
   * Called via postMessage from the child iframe when the ad/iframe starts
   * observing its position in the viewport.
   * Sets a flag, measures the iframe position if necessary and sends
   * one change record to the iframe.
   * Note that this method may be called more than once if a single ad
   * has multiple parties interested in viewability data.
   * @private
   */
  startSendingIntersectionChanges_() {
    this.shouldSendIntersectionChanges_ = true;
    this.baseElement_.getVsync().measure(() => {
      if (this.baseElement_.isInViewport()) {
        this.onViewportCallback(true);
      }
      this.fire();
    });
  }

  /**
   * Triggered by the AmpElement to when it either enters or exits the visible
   * viewport.
   * @param {boolean} inViewport true if the element is in viewport.
   */
  onViewportCallback(inViewport) {
    if (this.inViewport_ == inViewport) {
      return;
    }
    this.inViewport_ = inViewport;
    // Lets the ad know that it became visible or no longer is.
    this.fire();
    // And update the ad about its position in the viewport while
    // it is visible.
    if (inViewport) {
      const send = this.fire.bind(this);
      // Scroll events.
      const unlistenScroll = this.baseElement_.getViewport().onScroll(send);
      // Throttled scroll events. Also fires for resize events.
      const unlistenChanged = this.baseElement_.getViewport().onChanged(send);
      this.unlistenViewportChanges_ = () => {
        unlistenScroll();
        unlistenChanged();
      };
    } else if (this.unlistenViewportChanges_) {
      this.unlistenViewportChanges_();
      this.unlistenViewportChanges_ = null;
    }
  }

  /**
   * Sends 'intersection' message to ad/iframe with intersection change records
   * if this has been activated and we measured the layout box of the iframe
   * at least once.
   * @private
   */
  sendElementIntersection_() {
    if (!this.shouldSendIntersectionChanges_) {
      return;
    }
    const change = this.baseElement_.element.getIntersectionChangeEntry();
    if (this.pendingChanges_.length > 0 &&
        this.pendingChanges_[this.pendingChanges_.length - 1].time
        == change.time) {
      return;
    }
    this.pendingChanges_.push(change);
    if (!this.flushTimeout_) {
      // Send one immediately, …
      this.flush_();
      // but only send a maximum of 10 postMessages per second.
      this.flushTimeout_ = timer.delay(this.boundFlush_, 100);
    }
  }

  /**
   * @private
   */
  flush_() {
    this.flushTimeout_ = 0;
    if (!this.pendingChanges_.length) {
      return;
    }
    // Note that we multicast the update to all interested windows.
    postMessageToWindows(
        this.iframe_,
        this.clientWindows_,
        'intersection',
        {changes: this.pendingChanges_},
        this.is3p_);
    this.pendingChanges_.length = 0;
  }
}
