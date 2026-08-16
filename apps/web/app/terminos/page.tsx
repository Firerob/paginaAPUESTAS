import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Términos y Condiciones · Neon Arena",
  description: "Términos y Condiciones de Uso de la plataforma.",
};

export default function TerminosPage() {
  return (
    <main className="legal-page">
      <Link href="/" className="legal-back">
        <ArrowLeft size={15} strokeWidth={2.4} aria-hidden />
        Volver al lobby
      </Link>

      <h1 className="legal-title">Términos y Condiciones de Uso</h1>
      <p className="legal-updated">Última actualización: 16 de agosto de 2026</p>

      <p>
        Al acceder, registrarse o participar en cualquier partida o transacción dentro de esta
        plataforma (&quot;El Sitio&quot;), el usuario acepta estar legalmente vinculado a los
        siguientes Términos y Condiciones. Si no está de acuerdo con alguno de los términos, debe
        abandonar el sitio inmediatamente.
      </p>

      <h2>1. Naturaleza del Servicio y Asunción de Riesgo</h2>
      <p>
        1.1. El Sitio provee una plataforma de software para emparejamiento de jugadores en
        partidas 1v1 (uno contra uno) en las que los usuarios deciden voluntariamente apostar
        fondos propios.
      </p>
      <p>
        1.2. <strong>Riesgo Financiero:</strong> El usuario reconoce y acepta explícitamente que
        participar en los juegos conlleva un riesgo total de pérdida financiera. El usuario
        participa bajo su propio y exclusivo riesgo.
      </p>
      <p>
        1.3. <strong>Exención Absoluta:</strong> Los creadores, administradores, desarrolladores y
        dueños de esta plataforma no asumen, bajo ninguna circunstancia, responsabilidad alguna por
        las pérdidas económicas sufridas por los usuarios.
      </p>

      <h2>2. Mayoría de Edad y Legalidad</h2>
      <p>
        2.1. El uso de la plataforma está estrictamente restringido a personas mayores de 18 años
        (o la mayoría de edad legal en la jurisdicción del usuario).
      </p>
      <p>
        2.2. Es responsabilidad exclusiva del usuario verificar que el uso de esta plataforma, así
        como las apuestas en línea, sean legales en su país, estado o municipio de residencia. El
        Sitio se exime de cualquier responsabilidad si el usuario viola sus leyes locales.
      </p>

      <h2>3. Política Estricta de No Reembolsos</h2>
      <p>
        3.1. Todas las transacciones, recargas, apuestas y resultados de las partidas son
        definitivos e irreversibles.
      </p>
      <p>
        3.2. <strong>Cero Devoluciones:</strong> No se emitirán reembolsos ni devoluciones de
        dinero bajo ningún concepto, incluyendo, pero no limitándose a: pérdidas en el juego,
        arrepentimiento, baneos de cuenta, o fallos de conexión.
      </p>

      <h2>4. Fallos Técnicos, Conectividad y Desconexiones</h2>
      <p>
        4.1. <strong>El Servidor es la Verdad Absoluta:</strong> Los resultados de las partidas son
        procesados y determinados exclusivamente por el servidor del Sitio. En caso de discrepancia
        visual en el navegador del usuario, el registro del servidor es final e inapelable.
      </p>
      <p>
        4.2. <strong>Desconexiones:</strong> Si un usuario pierde la conexión a internet, sufre
        lag, o cierra el navegador durante una partida en curso, el sistema lo interpretará como
        abandono o inactividad, resultando en la pérdida automática de la partida y de los fondos
        apostados en esa ronda. El Sitio no se hace responsable por problemas de hardware,
        proveedores de internet (ISP) o cortes de energía del usuario.
      </p>

      <h2>5. Fraude, Bots y Suspensión de Cuentas</h2>
      <p>
        5.1. Está estrictamente prohibido el uso de software de terceros, bots, scripts,
        manipulación de paquetes, o explotación de vulnerabilidades (exploits) para obtener
        ventajas injustas.
      </p>
      <p>
        5.2. El Sitio se reserva el derecho de auditar partidas, bloquear fondos y suspender
        permanentemente cualquier cuenta sospechosa de fraude, sin previo aviso y sin derecho a
        retiro de los fondos o reembolso.
      </p>

      <h2>6. Indemnización</h2>
      <p>
        6.1. El usuario acepta indemnizar, defender y mantener indemne al creador, desarrolladores,
        afiliados y servidores del Sitio contra cualquier reclamación, demanda, daño, obligación,
        pérdida o gasto (incluyendo honorarios de abogados) que surjan de:
      </p>
      <ul className="legal-list">
        <li>El uso del Sitio por parte del usuario.</li>
        <li>La violación de estos Términos y Condiciones.</li>
        <li>La violación de cualquier ley local, estatal o federal aplicable por parte del usuario.</li>
      </ul>

      <h2>7. Disponibilidad del Servicio</h2>
      <p>
        7.1. El Sitio se proporciona &quot;tal cual&quot; (AS-IS) y &quot;según disponibilidad&quot;.
        No se garantiza que el servicio sea ininterrumpido, libre de errores o completamente seguro
        contra ataques cibernéticos. El creador se reserva el derecho de cerrar, suspender o dar de
        baja el servicio y los servidores en cualquier momento sin previo aviso ni obligación de
        compensación.
      </p>

      <h2>8. Impuestos</h2>
      <p>
        8.1. El usuario es el único responsable de declarar y pagar cualquier impuesto aplicable
        sobre las ganancias obtenidas en el Sitio, según lo dicte la normativa fiscal de Colombia o
        de su país de residencia tributaria.
      </p>

      <h2>9. Jurisdicción y Resolución de Conflictos</h2>
      <p>
        9.1. Estos términos se rigen e interpretan de acuerdo con las leyes de la República de
        Colombia. Cualquier disputa legal que surja en relación con este servicio deberá someterse a
        arbitraje o a la jurisdicción de los tribunales competentes en Colombia, renunciando el
        usuario a iniciar demandas colectivas (class actions) contra los creadores del Sitio.
      </p>

      <Link href="/" className="legal-back legal-back-bottom">
        <ArrowLeft size={15} strokeWidth={2.4} aria-hidden />
        Volver al lobby
      </Link>
    </main>
  );
}
