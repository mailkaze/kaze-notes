/** Nombre de fichero seguro para la ruta de Storage. */
function safeName(name: string): string {
  return name.replace(/[\\/#?[\]*]+/g, '_').slice(-120) || 'file'
}

/**
 * Ruta de un adjunto nuevo en Storage. Lleva un trozo aleatorio para que dos ficheros con el mismo nombre
 * subidos a la vez (p. ej. varias "image.png" pegadas en iOS) no se pisen.
 */
export function uploadPath(uid: string, noteId: string, fileName: string): string {
  return `users/${uid}/notes/${noteId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName(fileName)}`
}
