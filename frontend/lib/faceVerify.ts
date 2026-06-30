import * as faceapi from 'face-api.js'

const MODEL_URL = 'https://unpkg.com/face-api.js@0.22.2/weights'

let loaded = false
let loading: Promise<void> | null = null

export type DescriptorResult =
  | { ok: true; descriptor: Float32Array }
  | { ok: false; reason: 'no_face' | 'multiple_faces' | 'error'; message: string }

export type CompareResult =
  | { detected: true; distance: number; isMatch: boolean }
  | { detected: false }

export async function initFaceApi(): Promise<void> {
  if (loaded) return
  if (loading) return loading
  loading = Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]).then(() => { loaded = true })
  return loading
}

export async function generateDescriptor(
  el: HTMLVideoElement | HTMLImageElement,
): Promise<DescriptorResult> {
  try {
    const detections = await faceapi
      .detectAllFaces(el, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors()

    if (detections.length === 0) {
      return { ok: false, reason: 'no_face', message: 'No face detected' }
    }
    if (detections.length >= 2) {
      return { ok: false, reason: 'multiple_faces', message: 'Multiple faces detected' }
    }
    return { ok: true, descriptor: detections[0].descriptor }
  } catch (err) {
    return { ok: false, reason: 'error', message: String(err) }
  }
}

export async function compareDescriptor(
  ref: Float32Array,
  videoEl: HTMLVideoElement,
): Promise<CompareResult> {
  try {
    const detection = await faceapi
      .detectSingleFace(videoEl, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor()

    if (!detection) return { detected: false }

    const distance = faceapi.euclideanDistance(ref, detection.descriptor)
    return { detected: true, distance, isMatch: distance < 0.5 }
  } catch {
    return { detected: false }
  }
}
