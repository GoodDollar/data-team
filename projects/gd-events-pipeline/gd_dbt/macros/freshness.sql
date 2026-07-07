{% macro latest_closed_date() -%}
    DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
{%- endmacro %}

{% macro latest_closed_as_of_timestamp() -%}
    TIMESTAMP(CURRENT_DATE())
{%- endmacro %}