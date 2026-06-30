// MediaPipe face landmarker — singleton initialiser + gaze extraction
// Task 5: used by InterviewCapture.startFaceDetection for proctoring

import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision'

let faceLandmarker: FaceLandmarker | null = null

export async function initFaceLandmarker(): Promise<FaceLandmarker> {
  if (faceLandmarker) return faceLandmarker

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  )
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO',
    numFaces: 2,
  })
  return faceLandmarker
}

export interface GazeResult {
  faceCount: number
  yaw: number   // degrees left/right; |yaw| > 30 = looking away
  pitch: number // degrees up/down;   |pitch| > 30 = looking away
}

// Extract head-pose yaw and pitch from the first face's 4×4 transformation matrix
// (column-major layout as returned by MediaPipe)
export function extractGaze(result: FaceLandmarkerResult): GazeResult {
  const faceCount = result.faceLandmarks.length
  if (faceCount === 0) return { faceCount: 0, yaw: 0, pitch: 0 }

  const matrix = result.facialTransformationMatrixes?.[0]?.data
  if (!matrix) return { faceCount, yaw: 0, pitch: 0 }

  // Extract Euler angles from rotation matrix (column-major 4×4)
  const sinPitch = -matrix[9]
  const pitch = Math.asin(Math.max(-1, Math.min(1, sinPitch))) * (180 / Math.PI)
  const yaw = Math.atan2(matrix[8], matrix[10]) * (180 / Math.PI)

  return { faceCount, yaw, pitch }
}
